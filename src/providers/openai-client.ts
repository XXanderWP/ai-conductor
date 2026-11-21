import { classifyHttpError, type ConductorErrorCode } from '../errors.js';
import { retryAfterSeconds } from '../ratelimit.js';
import type { ChatOptions, GenerationParams, Message, TokenUsage, ToolCall } from '../types.js';
import { isToolCallMessage } from '../utils.js';
import {
  getFixedTemperature,
  isLikelyFreeModel,
  isLikelyVisionModel,
  PROVIDERS,
  resolveBaseUrl,
  type ProviderId,
} from './registry.js';

export interface OpenAIChatSuccess {
  /** Assistant text (`''` when the model returned only tool calls). */
  content: string;
  model?: string;
  usage?: TokenUsage;
  /** Normalized tool calls, present only when the model requested tools. */
  toolCalls?: ToolCall[];
  finishReason?: string;
  /** Reasoning text (`reasoning_content` / `reasoning` / `reasoning_details`), when sent. */
  reasoning?: string;
  headers: Record<string, string>;
  status: number;
  raw?: unknown;
}

export interface OpenAIChatError {
  status: number;
  message: string;
  code: ConductorErrorCode;
  retryAfterSec?: number;
  headers: Record<string, string>;
  /** Parsed provider error body. */
  body?: unknown;
  rateLimited: boolean;
  retryable: boolean;
  /** Text streamed before the failure. */
  partialContent?: string;
}

export type OpenAIChatResult =
  { ok: true; data: OpenAIChatSuccess } | { ok: false; error: OpenAIChatError };

export interface ResolvedProviderEndpoint {
  /** Provider type. */
  id: ProviderId;
  /** Instance id (defaults to the provider type). */
  instanceId?: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  params?: GenerationParams;
  /** Extra request headers from config. */
  headers?: Record<string, string>;
  /** Overrides the registry `supportsReasoningEffort`. */
  supportsReasoningEffort?: boolean;
  /** Overrides the registry `supportsStreamUsage`. */
  supportsStreamUsage?: boolean;
}

function flattenHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function lowerCaseKeys(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) out[key.toLowerCase()] = value;
  return out;
}

function mergeParams(
  provider: ProviderId,
  profileParams: GenerationParams | undefined,
  options?: ChatOptions,
): GenerationParams {
  const fixed = getFixedTemperature(provider);
  return {
    temperature: fixed !== undefined ? fixed : (options?.temperature ?? profileParams?.temperature),
    topP: options?.topP ?? profileParams?.topP,
    maxTokens: options?.maxTokens ?? profileParams?.maxTokens,
    frequencyPenalty: options?.frequencyPenalty ?? profileParams?.frequencyPenalty,
    presencePenalty: options?.presencePenalty ?? profileParams?.presencePenalty,
    stop: options?.stop ?? profileParams?.stop,
  };
}

/**
 * Whether the endpoint needs an API key. Custom `openai_compatible` gateways
 * (non-default `baseUrl`) may be anonymous.
 */
export function endpointRequiresApiKey(
  endpoint: Pick<ResolvedProviderEndpoint, 'id' | 'baseUrl'>,
): boolean {
  if (!PROVIDERS[endpoint.id].requiresApiKey) return false;
  if (endpoint.id === 'openai_compatible') {
    return resolveBaseUrl(endpoint.id, endpoint.baseUrl) === resolveBaseUrl(endpoint.id);
  }
  return true;
}

/**
 * Request headers: built-in defaults < config `headers` < request `headers` (keys lower-cased).
 * No `Authorization` header is sent without a key.
 */
function buildHeaders(
  endpoint: ResolvedProviderEndpoint,
  extra: Record<string, string> | undefined,
  json: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers['content-type'] = 'application/json';
  const token = endpoint.apiKey || (endpoint.id === 'ollama' ? 'ollama' : '');
  if (token) headers.authorization = `Bearer ${token}`;

  if (endpoint.id === 'openrouter') {
    headers['http-referer'] = 'https://github.com/XXanderWP/ai-conductor';
    headers['x-title'] = 'AI Conductor';
  }

  return { ...headers, ...lowerCaseKeys(endpoint.headers), ...lowerCaseKeys(extra) };
}

function failure(
  code: ConductorErrorCode,
  status: number,
  message: string,
  headers: Record<string, string> = {},
  extra: Partial<OpenAIChatError> = {},
): OpenAIChatError {
  return {
    status,
    message,
    code,
    headers,
    rateLimited: code === 'rate_limited',
    retryable: code === 'network' || code === 'timeout' || code === 'stalled',
    ...extra,
  };
}

type PreparedChatRequest =
  | {
      ok: true;
      url: string;
      model: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
      timeoutMs: number;
    }
  | { ok: false; error: OpenAIChatError };

function prepareChatRequest(
  endpoint: ResolvedProviderEndpoint,
  messages: Message[],
  options: ChatOptions | undefined,
  stream: boolean,
): PreparedChatRequest {
  const meta = PROVIDERS[endpoint.id];
  const label = endpoint.instanceId ?? endpoint.id;
  const baseUrl = resolveBaseUrl(endpoint.id, endpoint.baseUrl);
  const url = `${baseUrl}/chat/completions`;
  const params = mergeParams(endpoint.id, endpoint.params, options);
  const model = options?.model?.trim() || endpoint.model;

  if (!model) {
    return {
      ok: false,
      error: failure('config', 400, `No model configured for provider "${label}".`),
    };
  }

  if (endpointRequiresApiKey(endpoint) && !endpoint.apiKey) {
    return {
      ok: false,
      error: failure('config', 401, `API key required for provider "${label}".`),
    };
  }

  const assistantNullContent = meta.assistantNullContent ?? null;
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((message) =>
      isToolCallMessage(message) && !message.content
        ? { ...message, content: assistantNullContent }
        : message,
    ),
    stream,
    ...options?.metadata,
  };
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.topP !== undefined) body.top_p = params.topP;
  if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
  if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty;
  if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty;
  if (params.stop !== undefined) body.stop = params.stop;
  if (options?.tools?.length) {
    body.tools = options.tools;
    if (options.toolChoice !== undefined) body.tool_choice = options.toolChoice;
    if (options.parallelToolCalls !== undefined) {
      body.parallel_tool_calls = options.parallelToolCalls;
    }
  }
  if (
    options?.reasoningEffort !== undefined &&
    (endpoint.supportsReasoningEffort ?? meta.supportsReasoningEffort === true)
  ) {
    body.reasoning_effort = options.reasoningEffort;
  }
  if (
    stream &&
    body.stream_options === undefined &&
    (endpoint.supportsStreamUsage ?? meta.supportsStreamUsage === true)
  ) {
    body.stream_options = { include_usage: true };
  }
  if (options?.extraBody) Object.assign(body, options.extraBody);

  return {
    ok: true,
    url,
    model,
    headers: buildHeaders(endpoint, options?.headers, true),
    body,
    timeoutMs: options?.timeoutMs ?? 120_000,
  };
}

/** Unwrap array error bodies (Gemini returns `[{ error: { … } }]`). */
function unwrapErrorPayload(json: unknown): unknown {
  return Array.isArray(json) ? json[0] : json;
}

function errorMessageFromPayload(json: unknown, fallback: string): string {
  const payload = unwrapErrorPayload(json);
  const errObj = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  if (
    errObj.error &&
    typeof errObj.error === 'object' &&
    typeof (errObj.error as { message?: unknown }).message === 'string'
  ) {
    return (errObj.error as { message: string }).message;
  }
  if (typeof errObj.error === 'string') return errObj.error;
  if (typeof errObj.message === 'string') return errObj.message;
  return fallback;
}

function toHttpError(
  status: number,
  message: string,
  headers: Record<string, string>,
  body?: unknown,
): OpenAIChatError {
  const code = classifyHttpError(status, message);
  return {
    status,
    message,
    code,
    retryAfterSec: retryAfterSeconds(headers, body, message),
    headers,
    ...(body !== undefined ? { body } : {}),
    rateLimited: code === 'rate_limited',
    retryable: code === 'rate_limited' || status >= 500,
  };
}

async function readErrorResponse(
  response: Response,
  headers: Record<string, string>,
): Promise<OpenAIChatError> {
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return toHttpError(
    response.status,
    errorMessageFromPayload(json, text || response.statusText || `HTTP ${response.status}`),
    headers,
    json ?? (text || undefined),
  );
}

type AbortKind = 'aborted' | 'timeout' | 'stalled';

/** One internal AbortController per request with the reason of the first abort. */
class RequestAbort {
  readonly controller = new AbortController();
  kind?: AbortKind;
  message?: string;

  abort(kind: AbortKind, message: string): void {
    if (this.kind) return;
    this.kind = kind;
    this.message = message;
    this.controller.abort();
  }

  /** Link an external signal; returns a detach function that removes the listener. */
  link(external: AbortSignal | undefined): () => void {
    if (!external) return () => undefined;
    const onAbort = () => this.abort('aborted', 'Request cancelled');
    if (external.aborted) {
      onAbort();
      return () => undefined;
    }
    external.addEventListener('abort', onAbort, { once: true });
    return () => external.removeEventListener('abort', onAbort);
  }

  toError(error: unknown, partialContent?: string): OpenAIChatError {
    const extra = partialContent ? { partialContent } : {};
    if (this.kind) {
      return failure(this.kind, 0, this.message ?? 'Request cancelled', {}, extra);
    }
    const message = error instanceof Error ? error.message : String(error);
    return failure('network', 0, message, {}, extra);
  }
}

/**
 * Call an OpenAI-compatible `/chat/completions` endpoint via fetch.
 * `externalSignal` (or `options.signal`) cancels the request.
 */
export async function openaiChatCompletion(
  endpoint: ResolvedProviderEndpoint,
  messages: Message[],
  options?: ChatOptions,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  externalSignal?: AbortSignal,
): Promise<OpenAIChatResult> {
  const prepared = prepareChatRequest(endpoint, messages, options, false);
  if (!prepared.ok) return prepared;

  const { url, model, headers, body, timeoutMs } = prepared;
  const abort = new RequestAbort();
  const detach = abort.link(externalSignal ?? options?.signal);
  const timer =
    timeoutMs > 0
      ? setTimeout(
          () => abort.abort('timeout', `Request timed out after ${timeoutMs}ms`),
          timeoutMs,
        )
      : undefined;

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abort.controller.signal,
    });

    const responseHeaders = flattenHeaders(response.headers);
    if (!response.ok) {
      return { ok: false, error: await readErrorResponse(response, responseHeaders) };
    }

    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    const parsed = parseCompletionPayload(json);
    if (typeof parsed.content !== 'string' && !parsed.toolCalls) {
      return {
        ok: false,
        error: failure(
          'http',
          response.status,
          'Provider returned no message content.',
          responseHeaders,
          { retryable: true, ...(json !== undefined ? { body: json } : {}) },
        ),
      };
    }

    return {
      ok: true,
      data: {
        content: parsed.content ?? '',
        model: parsed.model ?? model,
        usage: parsed.usage,
        ...(parsed.toolCalls ? { toolCalls: parsed.toolCalls } : {}),
        ...(parsed.finishReason ? { finishReason: parsed.finishReason } : {}),
        ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}),
        headers: responseHeaders,
        status: response.status,
        raw: json,
      },
    };
  } catch (error) {
    return { ok: false, error: abort.toError(error) };
  } finally {
    clearTimeout(timer);
    detach();
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringifyArguments(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value);
}

/**
 * Normalize one provider tool call: object `arguments` → JSON string, missing `id` → generated.
 * Unknown keys (e.g. `extra_content`) are kept.
 */
function normalizeToolCall(raw: unknown, index: number, stamp: number): ToolCall {
  const src = isPlainObject(raw) ? raw : {};
  const fn = isPlainObject(src.function) ? src.function : {};
  const id = typeof src.id === 'string' && src.id ? src.id : `call_${stamp}_${index}`;
  return {
    ...src,
    id,
    type: 'function',
    function: {
      ...fn,
      name: typeof fn.name === 'string' ? fn.name : '',
      arguments: stringifyArguments(fn.arguments),
    },
  } as ToolCall;
}

function normalizeToolCalls(raw: unknown): ToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const stamp = Date.now();
  return raw.map((call, i) => normalizeToolCall(call, i, stamp));
}

function parseUsage(raw: unknown): TokenUsage | undefined {
  if (!isPlainObject(raw)) return undefined;
  const usage = raw as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

interface ParsedCompletion {
  /** `undefined` when the provider sent no string content. */
  content?: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  model?: string;
  usage?: TokenUsage;
  reasoning?: string;
}

/** Parse a non-streaming `/chat/completions` JSON body. */
function parseCompletionPayload(json: unknown): ParsedCompletion {
  const data = isPlainObject(json) ? json : {};
  const choice = Array.isArray(data.choices) ? (data.choices[0] as unknown) : undefined;
  const choiceObj = isPlainObject(choice) ? choice : {};
  const message = isPlainObject(choiceObj.message) ? choiceObj.message : {};
  return {
    content: typeof message.content === 'string' ? message.content : undefined,
    toolCalls: normalizeToolCalls(message.tool_calls),
    finishReason: typeof choiceObj.finish_reason === 'string' ? choiceObj.finish_reason : undefined,
    model: typeof data.model === 'string' ? data.model : undefined,
    usage: parseUsage(data.usage),
    reasoning: reasoningText(message) || undefined,
  };
}

/** Merge `extra_content` one level deep so nested keys (e.g. `google.*`) from chunks combine. */
function mergeExtraContent(
  target: Record<string, unknown> | undefined,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? { ...existing, ...value } : value;
  }
  return out;
}

interface ToolCallAccumulator {
  index?: number;
  id?: string;
  type?: string;
  name: string;
  arguments: string;
  extra_content?: Record<string, unknown>;
  rest: Record<string, unknown>;
}

/** Assemble streamed `delta.tool_calls[]` fragments by `index`. */
class ToolCallAssembler {
  private readonly calls: ToolCallAccumulator[] = [];

  add(fragments: unknown): void {
    if (!Array.isArray(fragments)) return;
    fragments.forEach((raw, position) => {
      if (!isPlainObject(raw)) return;
      const acc = this.slotFor(raw, fragments.length > 1 ? position : undefined);
      const {
        index: _index,
        id,
        type,
        function: fn,
        extra_content: extra,
        ...rest
      } = raw as Record<string, unknown>;
      if (acc.id === undefined && typeof id === 'string' && id) acc.id = id;
      if (acc.type === undefined && typeof type === 'string') acc.type = type;
      if (isPlainObject(fn)) {
        if (typeof fn.name === 'string') acc.name += fn.name;
        if (typeof fn.arguments === 'string') acc.arguments += fn.arguments;
        else if (fn.arguments !== undefined && fn.arguments !== null) {
          acc.arguments = JSON.stringify(fn.arguments);
        }
      }
      if (isPlainObject(extra)) acc.extra_content = mergeExtraContent(acc.extra_content, extra);
      Object.assign(acc.rest, rest);
    });
  }

  /**
   * Find the accumulator for a fragment: by `index`, else by `id`, else (no index / id)
   * the call at the same array position, or the last one for single-fragment chunks.
   */
  private slotFor(raw: Record<string, unknown>, position?: number): ToolCallAccumulator {
    const index = typeof raw.index === 'number' ? raw.index : undefined;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : undefined;
    let acc =
      index !== undefined
        ? this.calls.find((c) => c.index === index)
        : id !== undefined
          ? this.calls.find((c) => c.id === id)
          : this.calls[position ?? this.calls.length - 1];
    if (!acc) {
      acc = { index, name: '', arguments: '', rest: {} };
      this.calls.push(acc);
    }
    return acc;
  }

  finish(): ToolCall[] | undefined {
    if (this.calls.length === 0) return undefined;
    const ordered = [...this.calls].sort(
      (a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER),
    );
    return normalizeToolCalls(
      ordered.map((acc) => ({
        ...acc.rest,
        ...(acc.id ? { id: acc.id } : {}),
        type: acc.type ?? 'function',
        function: { name: acc.name, arguments: acc.arguments },
        ...(acc.extra_content ? { extra_content: acc.extra_content } : {}),
      })),
    );
  }
}

/** Stream activity kinds reported to {@link OpenAIStreamHooks.onActivity}. */
export type StreamActivity = 'reasoning' | 'text' | 'tool';

/** Optional stream callbacks and watchdogs. */
export interface OpenAIStreamHooks {
  onReasoning?: (text: string) => void;
  onActivity?: (kind: StreamActivity) => void;
  /** Abort when no bytes arrive for this long (default 60_000; `0` disables). */
  idleTimeoutMs?: number;
  /** Hard limit for the whole stream after headers (default 300_000; `0` disables). */
  totalTimeoutMs?: number;
}

/** Reasoning text from a delta or message (`reasoning_content`, `reasoning`, `reasoning_details`). */
function reasoningText(source: Record<string, unknown>): string {
  if (typeof source.reasoning_content === 'string') return source.reasoning_content;
  if (typeof source.reasoning === 'string') return source.reasoning;
  if (Array.isArray(source.reasoning_details)) {
    return source.reasoning_details
      .map((detail) =>
        isPlainObject(detail)
          ? typeof detail.text === 'string'
            ? detail.text
            : typeof detail.summary === 'string'
              ? detail.summary
              : ''
          : '',
      )
      .join('');
  }
  return '';
}

/** Mutable stream state, readable after a failure (partial content). */
interface SseState {
  content: string;
  reasoning: string;
  model?: string;
  usage?: TokenUsage;
  finishReason?: string;
  streamError?: { message: string; body: unknown };
  rawChunks: unknown[];
  toolCalls: ToolCallAssembler;
  /** True once at least one non-empty content delta was delivered to onDelta. */
  emitted: boolean;
}

function newSseState(): SseState {
  return {
    content: '',
    reasoning: '',
    rawChunks: [],
    toolCalls: new ToolCallAssembler(),
    emitted: false,
  };
}

/** Apply one parsed SSE `data:` JSON chunk to the state. */
function applySseChunk(
  state: SseState,
  json: unknown,
  onDelta: (delta: string) => void,
  hooks: OpenAIStreamHooks | undefined,
): void {
  state.rawChunks.push(json);
  const errorPayload = unwrapErrorPayload(json);
  if (isPlainObject(errorPayload) && errorPayload.error) {
    state.streamError = {
      message: errorMessageFromPayload(errorPayload, 'Provider sent an error in the stream.'),
      body: json,
    };
    return;
  }
  if (!isPlainObject(json)) return;

  if (typeof json.model === 'string' && json.model) state.model = json.model;

  const choice = Array.isArray(json.choices) ? (json.choices[0] as unknown) : undefined;
  if (isPlainObject(choice)) {
    const delta = isPlainObject(choice.delta) ? choice.delta : {};
    const reasoning = reasoningText(delta);
    if (reasoning) {
      state.reasoning += reasoning;
      hooks?.onReasoning?.(reasoning);
      hooks?.onActivity?.('reasoning');
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      state.content += delta.content;
      state.emitted = true;
      onDelta(delta.content);
      hooks?.onActivity?.('text');
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
      state.toolCalls.add(delta.tool_calls);
      hooks?.onActivity?.('tool');
    }
    if (typeof choice.finish_reason === 'string') state.finishReason = choice.finish_reason;
  }

  const groq = isPlainObject(json.x_groq) ? json.x_groq : undefined;
  const usage = parseUsage(json.usage) ?? parseUsage(groq?.usage);
  if (usage) state.usage = usage;
}

/**
 * Read an OpenAI-compatible SSE chat stream and invoke `onDelta` for each content piece.
 * Tool call fragments are assembled separately and never sent to `onDelta`.
 * A provider that ignores `stream: true` and returns plain JSON is parsed as a full completion.
 * `onBytes` is called for every received chunk (watchdog reset).
 */
async function readSseChatStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
  signal: AbortSignal,
  state: SseState,
  hooks: OpenAIStreamHooks | undefined,
  onBytes: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawData = false;
  let rawText = '';

  let detachAbort = () => undefined as void;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      const err = new Error('Request cancelled');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener('abort', onAbort, { once: true });
      detachAbort = () => signal.removeEventListener('abort', onAbort);
    }
  });
  aborted.catch(() => undefined);

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      onBytes();

      const decoded = decoder.decode(value, { stream: true });
      if (!sawData) rawText += decoded;
      buffer += decoded;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data:')) continue;
        sawData = true;
        rawText = '';

        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        let json: unknown;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        applySseChunk(state, json, onDelta, hooks);
      }
    }
  } finally {
    detachAbort();
    if (signal.aborted) void reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }

  if (!sawData) {
    // Provider ignored `stream: true` and answered with a regular JSON completion.
    let json: unknown;
    try {
      json = JSON.parse(rawText + decoder.decode());
    } catch {
      return;
    }
    state.rawChunks.push(json);
    const errorPayload = unwrapErrorPayload(json);
    if (isPlainObject(errorPayload) && errorPayload.error) {
      state.streamError = {
        message: errorMessageFromPayload(errorPayload, 'Provider returned an error.'),
        body: json,
      };
      return;
    }
    const parsed = parseCompletionPayload(json);
    if (parsed.reasoning) {
      state.reasoning = parsed.reasoning;
      hooks?.onReasoning?.(parsed.reasoning);
      hooks?.onActivity?.('reasoning');
    }
    if (parsed.content) {
      state.content = parsed.content;
      state.emitted = true;
      onDelta(parsed.content);
      hooks?.onActivity?.('text');
    }
    if (parsed.toolCalls) {
      state.toolCalls.add(parsed.toolCalls.map((call, index) => ({ ...call, index })));
      hooks?.onActivity?.('tool');
    }
    state.model = parsed.model;
    state.usage = parsed.usage;
    state.finishReason = parsed.finishReason;
  }
}

export interface OpenAIChatStreamSuccess extends OpenAIChatSuccess {
  /** True when at least one non-empty content delta was emitted to `onDelta`. */
  emitted: boolean;
}

export type OpenAIChatStreamResult =
  | { ok: true; data: OpenAIChatStreamSuccess }
  | { ok: false; error: OpenAIChatError; emitted: boolean };

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 300_000;

/**
 * Stream an OpenAI-compatible `/chat/completions` response (SSE).
 * Invokes `onDelta` for each content piece as it arrives.
 *
 * `options.timeoutMs` bounds the wait for response headers; `hooks.idleTimeoutMs` /
 * `hooks.totalTimeoutMs` guard the body (`stalled`).
 */
export async function openaiChatCompletionStream(
  endpoint: ResolvedProviderEndpoint,
  messages: Message[],
  onDelta: (delta: string) => void,
  options?: ChatOptions,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  externalSignal?: AbortSignal,
  hooks?: OpenAIStreamHooks,
): Promise<OpenAIChatStreamResult> {
  const prepared = prepareChatRequest(endpoint, messages, options, true);
  if (!prepared.ok) return { ...prepared, emitted: false };

  const { url, model, headers, body, timeoutMs } = prepared;
  const idleMs = hooks?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const totalMs = hooks?.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const state = newSseState();
  const abort = new RequestAbort();
  const detach = abort.link(externalSignal ?? options?.signal);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  const headerTimer =
    timeoutMs > 0
      ? setTimeout(
          () => abort.abort('timeout', `Request timed out after ${timeoutMs}ms`),
          timeoutMs,
        )
      : undefined;

  const resetIdle = () => {
    if (idleMs <= 0) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => abort.abort('stalled', `Stream stalled: no data for ${idleMs}ms`),
      idleMs,
    );
  };

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abort.controller.signal,
    });
    clearTimeout(headerTimer);

    const responseHeaders = flattenHeaders(response.headers);

    if (!response.ok) {
      return {
        ok: false,
        emitted: false,
        error: await readErrorResponse(response, responseHeaders),
      };
    }

    if (!response.body) {
      return {
        ok: false,
        emitted: false,
        error: failure(
          'http',
          response.status,
          'Provider returned an empty stream body.',
          responseHeaders,
          {
            retryable: true,
          },
        ),
      };
    }

    if (totalMs > 0) {
      totalTimer = setTimeout(
        () => abort.abort('stalled', `Stream exceeded the total timeout of ${totalMs}ms`),
        totalMs,
      );
    }
    resetIdle();
    await readSseChatStream(
      response.body,
      onDelta,
      abort.controller.signal,
      state,
      hooks,
      resetIdle,
    );

    const toolCalls = state.toolCalls.finish();
    const { emitted } = state;

    if (state.streamError && !state.content && !toolCalls) {
      return {
        ok: false,
        emitted,
        error: toHttpError(
          response.status,
          state.streamError.message,
          responseHeaders,
          state.streamError.body,
        ),
      };
    }

    if (!state.content && !toolCalls) {
      return {
        ok: false,
        emitted,
        error: failure(
          'http',
          response.status,
          'Provider returned no message content.',
          responseHeaders,
          {
            retryable: !emitted,
          },
        ),
      };
    }

    return {
      ok: true,
      data: {
        content: state.content,
        model: state.model ?? model,
        usage: state.usage,
        ...(toolCalls ? { toolCalls } : {}),
        ...(state.finishReason ? { finishReason: state.finishReason } : {}),
        ...(state.reasoning ? { reasoning: state.reasoning } : {}),
        headers: responseHeaders,
        status: response.status,
        raw: state.rawChunks,
        emitted,
      },
    };
  } catch (error) {
    const err = abort.toError(error, state.content || undefined);
    err.retryable = err.retryable && !state.emitted;
    return { ok: false, emitted: state.emitted, error: err };
  } finally {
    clearTimeout(headerTimer);
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    detach();
  }
}

/** Model entry from `GET /models` (OpenAI-compatible). */
export interface OpenAIModelInfo {
  id: string;
  ownedBy?: string;
  /** Input modalities from catalog metadata, when the provider reports them. */
  inputModalities?: string[];
  /** Catalog metadata when available, otherwise {@link isLikelyVisionModel}. */
  supportsVision?: boolean;
  contextLength?: number;
  supportsTools?: boolean;
  isFree?: boolean;
  raw?: unknown;
}

/** Options for {@link openaiListModels}. */
export interface OpenAIListModelsOptions {
  signal?: AbortSignal;
  /** Add `isFree` (heuristic fallback) and `raw` to every model. */
  details?: boolean;
}

function firstPositiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function freeFromPricing(pricing: unknown): boolean | undefined {
  if (!isPlainObject(pricing)) return undefined;
  const prices = [pricing.prompt, pricing.completion, pricing.input, pricing.output]
    .map((v) => (typeof v === 'string' ? Number(v) : v))
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return prices.length ? prices.every((v) => v === 0) : undefined;
}

function toolsFromCatalog(item: Record<string, unknown>): boolean | undefined {
  const params = readStringArray(item.supported_parameters);
  if (params) return params.includes('tools');
  const caps = item.capabilities;
  if (Array.isArray(caps)) {
    const list = readStringArray(caps) ?? [];
    return list.includes('tools') || list.includes('function_calling');
  }
  if (isPlainObject(caps)) {
    const flag = caps.function_calling ?? caps.tools ?? caps.tool_calling;
    if (typeof flag === 'boolean') return flag;
  }
  return undefined;
}

/** Optional catalog fields: context window, tool support, pricing, raw entry. */
function catalogFields(
  provider: ProviderId,
  id: string,
  item: Record<string, unknown>,
  details: boolean | undefined,
): Partial<OpenAIModelInfo> {
  const out: Partial<OpenAIModelInfo> = {};
  const topProvider = isPlainObject(item.top_provider) ? item.top_provider : {};
  const contextLength = firstPositiveNumber(
    item.context_length,
    item.context_window,
    item.inputTokenLimit,
    item.input_token_limit,
    item.max_context_length,
    topProvider.context_length,
  );
  if (contextLength !== undefined) out.contextLength = contextLength;
  const supportsTools = toolsFromCatalog(item);
  if (supportsTools !== undefined) out.supportsTools = supportsTools;
  const isFree = freeFromPricing(item.pricing);
  if (isFree !== undefined) out.isFree = isFree;
  else if (details) out.isFree = isLikelyFreeModel(provider, id);
  if (details) out.raw = item;
  return out;
}

/** Timeout + external signal for catalog requests. */
function catalogAbort(timeoutMs: number, signal: AbortSignal | undefined) {
  const abort = new RequestAbort();
  const detach = abort.link(signal);
  const timer = setTimeout(
    () => abort.abort('timeout', `Request timed out after ${timeoutMs}ms`),
    timeoutMs,
  );
  return {
    signal: abort.controller.signal,
    message: (error: unknown) => abort.toError(error).message,
    done: () => {
      clearTimeout(timer);
      detach();
    },
  };
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase());
  return out.length ? out : undefined;
}

/**
 * Extract input modalities from common catalog shapes:
 * OpenRouter `architecture.input_modalities`, plain `input_modalities` / `modalities`.
 */
function parseInputModalities(item: Record<string, unknown>): string[] | undefined {
  const architecture = item.architecture;
  if (architecture && typeof architecture === 'object') {
    const fromArch = readStringArray((architecture as Record<string, unknown>).input_modalities);
    if (fromArch) return fromArch;
  }
  const direct = readStringArray(item.input_modalities);
  if (direct) return direct;
  const modalities = item.modalities;
  if (modalities && typeof modalities === 'object' && !Array.isArray(modalities)) {
    return readStringArray((modalities as Record<string, unknown>).input);
  }
  return readStringArray(modalities);
}

function withVision(
  provider: ProviderId,
  info: { id: string; ownedBy?: string },
  inputModalities?: string[],
): OpenAIModelInfo {
  const supportsVision = !PROVIDERS[provider].supportsVision
    ? false
    : inputModalities
      ? inputModalities.includes('image')
      : isLikelyVisionModel(provider, info.id);
  return { ...info, ...(inputModalities ? { inputModalities } : {}), supportsVision };
}

export type OpenAIListModelsResult =
  { ok: true; models: OpenAIModelInfo[] } | { ok: false; error: string; status: number };

/** Puter AI Gateway public catalog (OpenAI `/models` returns 404). */
const PUTER_MODELS_DETAILS_URL = 'https://api.puter.com/puterai/chat/models/details';

/**
 * Normalize provider-specific model ids from catalog responses.
 * Gemini often returns `models/…`; typos like `gemini-2.0.flash` are fixed.
 */
export function normalizeProviderModelId(provider: ProviderId, model: string): string {
  let id = model.trim();
  if (!id) return id;

  if (provider === 'gemini') {
    id = id.replace(/^models\//i, '');
    id = id.replace(/^(gemini-\d+\.\d+)\.(.+)$/i, '$1-$2');
  }

  return id;
}

function parseOpenAIModelsPayload(
  provider: ProviderId,
  json: unknown,
  details?: boolean,
): OpenAIModelInfo[] {
  const data = json && typeof json === 'object' ? (json as { data?: unknown }).data : undefined;
  const list = Array.isArray(data) ? data : [];
  const models: OpenAIModelInfo[] = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const rawId = (item as { id?: unknown }).id;
    if (typeof rawId !== 'string' || !rawId.trim()) continue;
    const ownedBy = (item as { owned_by?: unknown }).owned_by;
    const id = normalizeProviderModelId(provider, rawId);
    models.push({
      ...withVision(
        provider,
        { id, ownedBy: typeof ownedBy === 'string' ? ownedBy : undefined },
        parseInputModalities(item as Record<string, unknown>),
      ),
      ...catalogFields(provider, id, item as Record<string, unknown>, details),
    });
  }

  return models;
}

async function listPuterModels(
  timeoutMs: number,
  fetchImpl: typeof globalThis.fetch,
  options?: OpenAIListModelsOptions,
): Promise<OpenAIListModelsResult> {
  const abort = catalogAbort(timeoutMs, options?.signal);
  try {
    const response = await fetchImpl(PUTER_MODELS_DETAILS_URL, {
      method: 'GET',
      signal: abort.signal,
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: text || response.statusText || `HTTP ${response.status}`,
      };
    }

    const raw =
      json && typeof json === 'object' ? (json as { models?: unknown }).models : undefined;
    if (!Array.isArray(raw)) {
      return { ok: false, status: response.status, error: 'Invalid Puter models response.' };
    }

    const models: OpenAIModelInfo[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const idRaw = (item as { id?: unknown }).id;
      if (typeof idRaw !== 'string' || !idRaw.trim()) continue;
      const id = idRaw.trim();
      if (seen.has(id)) continue;
      seen.add(id);
      const provider = (item as { provider?: unknown }).provider;
      models.push({
        ...withVision(
          'puter',
          { id, ownedBy: typeof provider === 'string' ? provider : 'puter' },
          parseInputModalities(item as Record<string, unknown>),
        ),
        ...catalogFields('puter', id, item as Record<string, unknown>, options?.details),
      });
    }

    return { ok: true, models };
  } catch (error) {
    return { ok: false, status: 0, error: abort.message(error) };
  } finally {
    abort.done();
  }
}

async function listOllamaNativeTags(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl: typeof globalThis.fetch,
  options?: OpenAIListModelsOptions,
): Promise<OpenAIListModelsResult> {
  const nativeBase = baseUrl.replace(/\/v1\/?$/, '');
  const abort = catalogAbort(timeoutMs, options?.signal);
  try {
    const response = await fetchImpl(`${nativeBase}/api/tags`, {
      method: 'GET',
      signal: abort.signal,
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: text || response.statusText || `HTTP ${response.status}`,
      };
    }

    const modelsRaw =
      json && typeof json === 'object' ? (json as { models?: unknown }).models : undefined;
    const models: OpenAIModelInfo[] = [];
    if (Array.isArray(modelsRaw)) {
      for (const item of modelsRaw) {
        const name =
          item && typeof item === 'object' ? (item as { name?: unknown }).name : undefined;
        if (typeof name === 'string' && name.trim()) {
          const id = name.trim();
          models.push({
            ...withVision('ollama', { id, ownedBy: 'ollama' }),
            ...(options?.details ? { isFree: true, raw: item } : {}),
          });
        }
      }
    }
    return { ok: true, models };
  } catch (error) {
    return { ok: false, status: 0, error: abort.message(error) };
  } finally {
    abort.done();
  }
}

/**
 * List models from an OpenAI-compatible `GET /models` endpoint.
 * Puter uses a public catalog; Ollama falls back to native `/api/tags`.
 */
export async function openaiListModels(
  endpoint: ResolvedProviderEndpoint,
  timeoutMs = 15_000,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  options?: OpenAIListModelsOptions,
): Promise<OpenAIListModelsResult> {
  if (endpointRequiresApiKey(endpoint) && !endpoint.apiKey) {
    return {
      ok: false,
      status: 401,
      error: `API key required for provider "${endpoint.instanceId ?? endpoint.id}".`,
    };
  }

  if (endpoint.id === 'puter') {
    return listPuterModels(timeoutMs, fetchImpl, options);
  }

  const baseUrl = resolveBaseUrl(endpoint.id, endpoint.baseUrl);
  const url = `${baseUrl}/models`;
  const headers = buildHeaders(endpoint, undefined, false);
  const abort = catalogAbort(timeoutMs, options?.signal);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: abort.signal,
    });

    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    if (!response.ok) {
      if (endpoint.id === 'ollama') {
        const fallback = await listOllamaNativeTags(baseUrl, timeoutMs, fetchImpl, options);
        if (fallback.ok) return fallback;
      }

      const payload = unwrapErrorPayload(json);
      const errObj =
        payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
      const errMsg =
        (errObj.error &&
          typeof errObj.error === 'object' &&
          typeof (errObj.error as { message?: unknown }).message === 'string' &&
          (errObj.error as { message: string }).message) ||
        (typeof errObj.message === 'string' && errObj.message) ||
        text ||
        response.statusText ||
        `HTTP ${response.status}`;

      return { ok: false, status: response.status, error: String(errMsg) };
    }

    return { ok: true, models: parseOpenAIModelsPayload(endpoint.id, json, options?.details) };
  } catch (error) {
    const message = abort.message(error);
    if (endpoint.id === 'ollama' && !options?.signal?.aborted) {
      const fallback = await listOllamaNativeTags(baseUrl, timeoutMs, fetchImpl, options);
      if (fallback.ok) return fallback;
    }
    return { ok: false, status: 0, error: message };
  } finally {
    abort.done();
  }
}

/** Result of {@link detectOllama}. */
export interface DetectOllamaResult {
  ok: boolean;
  /** OpenAI-compatible base URL (`…/v1`). */
  baseUrl: string;
  models?: OpenAIModelInfo[];
  error?: string;
}

/**
 * Check whether an Ollama server answers at `baseUrl` (default `http://127.0.0.1:11434`)
 * via its native `/api/tags`, and list the installed models.
 */
export async function detectOllama(
  baseUrl?: string,
  options?: { timeoutMs?: number; signal?: AbortSignal; fetch?: typeof globalThis.fetch },
): Promise<DetectOllamaResult> {
  const native = (baseUrl?.trim() || PROVIDERS.ollama.defaultBaseUrl)
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '');
  const result = await listOllamaNativeTags(
    native,
    options?.timeoutMs ?? 2_000,
    options?.fetch ?? globalThis.fetch,
    { signal: options?.signal },
  );
  const openaiBase = `${native}/v1`;
  return result.ok
    ? { ok: true, baseUrl: openaiBase, models: result.models }
    : { ok: false, baseUrl: openaiBase, error: result.error };
}
