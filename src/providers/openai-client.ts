import type { ChatOptions, GenerationParams, Message, TokenUsage } from '../types.js';
import {
  getFixedTemperature,
  isLikelyVisionModel,
  PROVIDERS,
  resolveBaseUrl,
  type ProviderId,
} from './registry.js';

export interface OpenAIChatSuccess {
  content: string;
  model?: string;
  usage?: TokenUsage;
  headers: Record<string, string>;
  status: number;
  raw?: unknown;
}

export interface OpenAIChatError {
  status: number;
  message: string;
  retryAfterSec?: number;
  headers: Record<string, string>;
  rateLimited: boolean;
  retryable: boolean;
}

export type OpenAIChatResult =
  { ok: true; data: OpenAIChatSuccess } | { ok: false; error: OpenAIChatError };

export interface ResolvedProviderEndpoint {
  id: ProviderId;
  model: string;
  apiKey: string;
  baseUrl: string;
  params?: GenerationParams;
}

function flattenHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function parseRetryAfterSeconds(headers: Record<string, string>): number | undefined {
  const raw = headers['retry-after'];
  if (!raw) return undefined;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum >= 0) return asNum;
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  }
  return undefined;
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
  const baseUrl = resolveBaseUrl(endpoint.id, endpoint.baseUrl);
  const url = `${baseUrl}/chat/completions`;
  const params = mergeParams(endpoint.id, endpoint.params, options);
  const model = options?.model?.trim() || endpoint.model;

  if (!model) {
    return {
      ok: false,
      error: {
        status: 400,
        message: `No model configured for provider "${endpoint.id}".`,
        headers: {},
        rateLimited: false,
        retryable: false,
      },
    };
  }

  if (meta.requiresApiKey && !endpoint.apiKey) {
    return {
      ok: false,
      error: {
        status: 401,
        message: `API key required for provider "${endpoint.id}".`,
        headers: {},
        rateLimited: false,
        retryable: false,
      },
    };
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    stream,
    ...options?.metadata,
  };
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.topP !== undefined) body.top_p = params.topP;
  if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
  if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty;
  if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty;
  if (params.stop !== undefined) body.stop = params.stop;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${endpoint.apiKey || (endpoint.id === 'ollama' ? 'ollama' : '')}`,
  };

  if (endpoint.id === 'openrouter') {
    headers['http-referer'] = 'https://github.com/XXanderWP/ai-conductor';
    headers['x-title'] = 'AI Conductor';
  }

  return {
    ok: true,
    url,
    model,
    headers,
    body,
    timeoutMs: options?.timeoutMs ?? 120_000,
  };
}

function errorMessageFromPayload(json: unknown, fallback: string): string {
  const errObj = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  if (
    errObj.error &&
    typeof errObj.error === 'object' &&
    typeof (errObj.error as { message?: unknown }).message === 'string'
  ) {
    return (errObj.error as { message: string }).message;
  }
  if (typeof errObj.message === 'string') return errObj.message;
  return fallback;
}

function toHttpError(
  status: number,
  message: string,
  headers: Record<string, string>,
): OpenAIChatError {
  const rateLimited = status === 429 || /rate.?limit|resource.?exhausted/i.test(message);
  return {
    status,
    message,
    retryAfterSec: parseRetryAfterSeconds(headers),
    headers,
    rateLimited,
    retryable: rateLimited || status >= 500,
  };
}

function abortErrorMessage(
  error: unknown,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): string {
  if (externalSignal?.aborted) return 'Request cancelled';
  if (error instanceof Error && error.name === 'AbortError') {
    return `Request timed out after ${timeoutMs}ms`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function attachAbortBridge(
  externalSignal: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (!externalSignal) return () => undefined;
  if (externalSignal.aborted) {
    controller.abort();
    return () => undefined;
  }
  const onAbort = () => controller.abort();
  externalSignal.addEventListener('abort', onAbort, { once: true });
  return () => externalSignal.removeEventListener('abort', onAbort);
}

interface SseStreamParseResult {
  content: string;
  model?: string;
  usage?: TokenUsage;
  rawChunks: unknown[];
  /** True once at least one non-empty content delta was delivered to onDelta. */
  emitted: boolean;
}

/**
 * Read an OpenAI-compatible SSE chat stream and invoke `onDelta` for each content piece.
 */
async function readSseChatStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<SseStreamParseResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let model: string | undefined;
  let usage: TokenUsage | undefined;
  const rawChunks: unknown[] = [];
  let emitted = false;

  const throwIfAborted = () => {
    if (signal?.aborted) {
      const err = new Error('Request cancelled');
      err.name = 'AbortError';
      throw err;
    }
  };

  try {
    while (true) {
      throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data:')) continue;

        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        let json: unknown;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }

        rawChunks.push(json);
        const obj = json as {
          model?: string;
          choices?: Array<{ delta?: { content?: string | null } }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
        };

        if (typeof obj.model === 'string' && obj.model) model = obj.model;

        const delta = obj.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          content += delta;
          emitted = true;
          onDelta(delta);
        }

        if (obj.usage) {
          usage = {
            promptTokens: obj.usage.prompt_tokens,
            completionTokens: obj.usage.completion_tokens,
            totalTokens: obj.usage.total_tokens,
          };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { content, model, usage, rawChunks, emitted };
}

/**
 * Call an OpenAI-compatible `/chat/completions` endpoint via fetch.
 */
export async function openaiChatCompletion(
  endpoint: ResolvedProviderEndpoint,
  messages: Message[],
  options?: ChatOptions,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<OpenAIChatResult> {
  const prepared = prepareChatRequest(endpoint, messages, options, false);
  if (!prepared.ok) return prepared;

  const { url, model, headers, body, timeoutMs } = prepared;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const responseHeaders = flattenHeaders(response.headers);
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
        error: toHttpError(
          response.status,
          errorMessageFromPayload(json, text || response.statusText),
          responseHeaders,
        ),
      };
    }

    const data = json as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return {
        ok: false,
        error: {
          status: response.status,
          message: 'Provider returned no message content.',
          headers: responseHeaders,
          rateLimited: false,
          retryable: true,
        },
      };
    }

    return {
      ok: true,
      data: {
        content,
        model: data.model ?? model,
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
            }
          : undefined,
        headers: responseHeaders,
        status: response.status,
        raw: json,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        status: 0,
        message: abortErrorMessage(error, timeoutMs),
        headers: {},
        rateLimited: false,
        retryable: true,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface OpenAIChatStreamSuccess extends OpenAIChatSuccess {
  /** True when at least one non-empty content delta was emitted to `onDelta`. */
  emitted: boolean;
}

export type OpenAIChatStreamResult =
  | { ok: true; data: OpenAIChatStreamSuccess }
  | { ok: false; error: OpenAIChatError; emitted: boolean };

/**
 * Stream an OpenAI-compatible `/chat/completions` response (SSE).
 * Invokes `onDelta` for each content piece as it arrives.
 */
export async function openaiChatCompletionStream(
  endpoint: ResolvedProviderEndpoint,
  messages: Message[],
  onDelta: (delta: string) => void,
  options?: ChatOptions,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  externalSignal?: AbortSignal,
): Promise<OpenAIChatStreamResult> {
  const prepared = prepareChatRequest(endpoint, messages, options, true);
  if (!prepared.ok) return { ...prepared, emitted: false };

  const { url, model, headers, body, timeoutMs } = prepared;
  const controller = new AbortController();
  const detachExternal = attachAbortBridge(externalSignal, controller);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let emitted = false;

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const responseHeaders = flattenHeaders(response.headers);

    if (!response.ok) {
      const text = await response.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }

      return {
        ok: false,
        emitted: false,
        error: toHttpError(
          response.status,
          errorMessageFromPayload(json, text || response.statusText),
          responseHeaders,
        ),
      };
    }

    if (!response.body) {
      return {
        ok: false,
        emitted: false,
        error: {
          status: response.status,
          message: 'Provider returned an empty stream body.',
          headers: responseHeaders,
          rateLimited: false,
          retryable: true,
        },
      };
    }

    const parsed = await readSseChatStream(response.body, onDelta, controller.signal);
    emitted = parsed.emitted;

    if (!parsed.content) {
      return {
        ok: false,
        emitted,
        error: {
          status: response.status,
          message: 'Provider returned no message content.',
          headers: responseHeaders,
          rateLimited: false,
          retryable: !emitted,
        },
      };
    }

    return {
      ok: true,
      data: {
        content: parsed.content,
        model: parsed.model ?? model,
        usage: parsed.usage,
        headers: responseHeaders,
        status: response.status,
        raw: parsed.rawChunks,
        emitted,
      },
    };
  } catch (error) {
    return {
      ok: false,
      emitted,
      error: {
        status: 0,
        message: abortErrorMessage(error, timeoutMs, externalSignal),
        headers: {},
        rateLimited: false,
        retryable: !emitted && !externalSignal?.aborted,
      },
    };
  } finally {
    clearTimeout(timer);
    detachExternal();
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

function parseOpenAIModelsPayload(provider: ProviderId, json: unknown): OpenAIModelInfo[] {
  const data = json && typeof json === 'object' ? (json as { data?: unknown }).data : undefined;
  const list = Array.isArray(data) ? data : [];
  const models: OpenAIModelInfo[] = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const rawId = (item as { id?: unknown }).id;
    if (typeof rawId !== 'string' || !rawId.trim()) continue;
    const ownedBy = (item as { owned_by?: unknown }).owned_by;
    models.push(
      withVision(
        provider,
        {
          id: normalizeProviderModelId(provider, rawId),
          ownedBy: typeof ownedBy === 'string' ? ownedBy : undefined,
        },
        parseInputModalities(item as Record<string, unknown>),
      ),
    );
  }

  return models;
}

async function listPuterModels(
  timeoutMs: number,
  fetchImpl: typeof globalThis.fetch,
): Promise<OpenAIListModelsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(PUTER_MODELS_DETAILS_URL, {
      method: 'GET',
      signal: controller.signal,
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
      models.push(
        withVision(
          'puter',
          { id, ownedBy: typeof provider === 'string' ? provider : 'puter' },
          parseInputModalities(item as Record<string, unknown>),
        ),
      );
    }

    return { ok: true, models };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === 'AbortError'
          ? `Request timed out after ${timeoutMs}ms`
          : error.message
        : String(error);
    return { ok: false, status: 0, error: message };
  } finally {
    clearTimeout(timer);
  }
}

async function listOllamaNativeTags(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl: typeof globalThis.fetch,
): Promise<OpenAIListModelsResult> {
  const nativeBase = baseUrl.replace(/\/v1\/?$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${nativeBase}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
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
          models.push(withVision('ollama', { id: name.trim(), ownedBy: 'ollama' }));
        }
      }
    }
    return { ok: true, models };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === 'AbortError'
          ? `Request timed out after ${timeoutMs}ms`
          : error.message
        : String(error);
    return { ok: false, status: 0, error: message };
  } finally {
    clearTimeout(timer);
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
): Promise<OpenAIListModelsResult> {
  const meta = PROVIDERS[endpoint.id];

  if (meta.requiresApiKey && !endpoint.apiKey) {
    return {
      ok: false,
      status: 401,
      error: `API key required for provider "${endpoint.id}".`,
    };
  }

  if (endpoint.id === 'puter') {
    return listPuterModels(timeoutMs, fetchImpl);
  }

  const baseUrl = resolveBaseUrl(endpoint.id, endpoint.baseUrl);
  const url = `${baseUrl}/models`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${endpoint.apiKey || (endpoint.id === 'ollama' ? 'ollama' : '')}`,
  };

  if (endpoint.id === 'openrouter') {
    headers['http-referer'] = 'https://github.com/XXanderWP/ai-conductor';
    headers['x-title'] = 'AI Conductor';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
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
        const fallback = await listOllamaNativeTags(baseUrl, timeoutMs, fetchImpl);
        if (fallback.ok) return fallback;
      }

      const errObj = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
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

    return { ok: true, models: parseOpenAIModelsPayload(endpoint.id, json) };
  } catch (error) {
    if (endpoint.id === 'ollama') {
      const fallback = await listOllamaNativeTags(baseUrl, timeoutMs, fetchImpl);
      if (fallback.ok) return fallback;
    }

    const message =
      error instanceof Error
        ? error.name === 'AbortError'
          ? `Request timed out after ${timeoutMs}ms`
          : error.message
        : String(error);
    return { ok: false, status: 0, error: message };
  } finally {
    clearTimeout(timer);
  }
}
