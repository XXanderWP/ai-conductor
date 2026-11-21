/**
 * Shared message and chat option types.
 */

import type { ProviderId } from './providers/registry.js';

/** Chat message role. */
export type MessageRole = 'system' | 'user' | 'assistant';

/** Plain text part of a multimodal message. */
export interface TextContentPart {
  type: 'text';
  text: string;
}

/** Image detail hint (OpenAI-compatible; ignored by providers that do not support it). */
export type ImageDetail = 'auto' | 'low' | 'high';

/** Image part of a multimodal message (OpenAI-compatible `image_url`). */
export interface ImageContentPart {
  type: 'image_url';
  image_url: {
    /** `https://…` URL or `data:<mime>;base64,…` URL. */
    url: string;
    detail?: ImageDetail;
  };
}

/** One part of a multimodal message. */
export type MessageContentPart = TextContentPart | ImageContentPart;

/** Plain text / multimodal chat message. Use content parts to send images to vision-capable models. */
export interface TextMessage {
  role: MessageRole;
  content: string | MessageContentPart[];
}

/** JSON Schema object describing function parameters. */
export type JsonSchema = Record<string, unknown>;

/** OpenAI-compatible tool (function) definition sent in `tools`. */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: JsonSchema;
    strict?: boolean;
  };
}

/** OpenAI-compatible `tool_choice`. */
export type ToolChoice =
  'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };

/** Tool call requested by the model. */
export interface ToolCall {
  id: string;
  type: 'function';
  /** `arguments` is the raw JSON string as sent by the provider. */
  function: { name: string; arguments: string };
  /** Opaque provider data that MUST be echoed back unchanged (e.g. Gemini `google.thought_signature`). */
  extra_content?: Record<string, unknown>;
}

/** Assistant turn that requested tool calls. Push it into history before the tool results. */
export interface AssistantToolCallMessage {
  role: 'assistant';
  content: string | null;
  tool_calls: ToolCall[];
}

/** Result of one tool call, sent back to the model. */
export interface ToolResultMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
  name?: string;
}

/** A single chat message. */
export type Message = TextMessage | AssistantToolCallMessage | ToolResultMessage;

/** Per-request generation overrides. */
export interface ChatOptions {
  /** Force a specific configured provider id. */
  provider?: ProviderId | string;
  model?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
  /**
   * Request timeout in milliseconds (default 120_000). For streams: the wait for response
   * headers (see {@link ChatStreamOptions.idleTimeoutMs} / `totalTimeoutMs` for the body).
   */
  timeoutMs?: number;
  /** Extra OpenAI-compatible body fields (spread right after `model` / `messages` / `stream`). */
  metadata?: Record<string, unknown>;
  /** Extra body fields merged into the request body **last** (override everything). */
  extraBody?: Record<string, unknown>;
  /** Extra request headers (override config `headers` and built-in defaults). */
  headers?: Record<string, string>;
  /** Cancel the request. Rejects with `ConductorError` `code: 'aborted'` and stops failover. */
  signal?: AbortSignal;
  /**
   * `false`: no routing strategy and no fallback list. With `provider`, call exactly that
   * instance; without it, only the first routed one. Default `true`.
   */
  fallback?: boolean;
  /** Extra attempts on the same provider for retryable errors (default `0`). */
  retries?: number;
  /** OpenAI `reasoning_effort`; sent only to providers with `supportsReasoningEffort`. */
  reasoningEffort?: ReasoningEffort;
  /** Remove `<think>…</think>` blocks from `content` and streamed text. Default `false`. */
  stripThinking?: boolean;
  /** Tools the model may call (OpenAI `tools`). Providers with `supportsTools: false` are skipped. */
  tools?: ToolDefinition[];
  /** OpenAI `tool_choice`; sent only when `tools` is non-empty. */
  toolChoice?: ToolChoice;
  /** OpenAI `parallel_tool_calls`; sent only when defined and `tools` is non-empty. */
  parallelToolCalls?: boolean;
  /**
   * History with tool calls / tool results is pinned to one provider (tool call ids and
   * `extra_content` belong to the provider that issued them). Set `true` to allow failover anyway.
   */
  allowToolFailover?: boolean;
}

/** OpenAI-compatible `reasoning_effort` values. */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

/** Token usage when reported by the provider. */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** Successful chat response from {@link Conductor.chat}. */
export interface ChatResponse {
  content: string;
  /** Provider instance id (equals the provider type for single-instance configs). */
  provider: ProviderId | string;
  /** Provider type of {@link provider}. */
  providerType?: ProviderId;
  model?: string;
  usage?: TokenUsage;
  /** Routing strategy that selected the provider. */
  strategy: RoutingStrategy;
  /** Providers that failed before success. */
  failedProviders?: string[];
  /** Raw provider JSON body when available. */
  raw?: unknown;
  /** Tool calls requested by the model (present only when it requested tools). */
  toolCalls?: ToolCall[];
  /** Provider `finish_reason` (`stop`, `tool_calls`, `length`, …). */
  finishReason?: string;
  /** Lower-cased response headers of the successful call (`x-ratelimit-*`, gateway headers). */
  headers?: Record<string, string>;
  /** Reasoning text collected from the provider (or stripped `<think>` blocks). */
  reasoning?: string;
}

/**
 * How {@link Conductor.chatStream} delivers text to the chunk callback.
 * - `delta` (default): each piece as received (`"Пр"`, `"и"`, …)
 * - `cumulative`: full text so far (`"Пр"`, `"При"`, …)
 */
export type StreamChunkMode = 'delta' | 'cumulative';

/** Per-request options for {@link Conductor.chatStream}. */
export interface ChatStreamOptions extends ChatOptions {
  /** Callback payload shape. Default: `delta`. */
  chunkMode?: StreamChunkMode;
  /** Called once per finished tool call when the stream ends (tool fragments never reach `onChunk`). */
  onToolCall?: (call: ToolCall) => void;
  /** Abort when no bytes arrive for this long (default 60_000; `0` disables). Rejects with `stalled`. */
  idleTimeoutMs?: number;
  /** Hard limit for the whole stream (default 300_000; `0` disables). Rejects with `stalled`. */
  totalTimeoutMs?: number;
  /** Reasoning deltas (`reasoning` / `reasoning_content` / `reasoning_details`, stripped `<think>`). */
  onReasoning?: (text: string) => void;
  /** Called for every chunk of that kind (e.g. for a "model is thinking…" indicator). */
  onActivity?: (kind: 'reasoning' | 'text' | 'tool') => void;
}

/** Handle returned by {@link Conductor.chatStream}. */
export interface ChatStreamHandle {
  /** Resolves with the same shape as {@link Conductor.chat} when the stream finishes. */
  result: Promise<ChatResponse>;
  /** Abort the in-flight stream (and skip remaining failover attempts). */
  cancel: () => void;
}

/** Callback invoked for each streamed piece of assistant text. */
export type ChatStreamChunkCallback = (text: string) => void;

/** How Conductor picks the next provider. */
export type RoutingStrategy =
  'cheapest' | 'priority' | 'round-robin' | 'failover' | 'first-available';

/** Generation defaults shared by config / provider entries. */
export interface GenerationParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
}

/** Model entry returned by {@link Conductor.listModels}. */
export interface ModelInfo {
  id: string;
  ownedBy?: string;
  /** Input modalities reported by the provider catalog (e.g. OpenRouter `["text","image"]`). */
  inputModalities?: string[];
  /**
   * Whether the model accepts image inputs. Taken from catalog metadata when the provider
   * reports it, otherwise from {@link isLikelyVisionModel}.
   */
  supportsVision?: boolean;
  /** Context window in tokens (`context_length` / `context_window` / `inputTokenLimit`). */
  contextLength?: number;
  /** Tool support from `supported_parameters` / capability fields, when reported. */
  supportsTools?: boolean;
  /** From catalog pricing when present; with `details: true`, falls back to `isLikelyFreeModel`. */
  isFree?: boolean;
  /** Raw catalog entry (only with `details: true`). */
  raw?: unknown;
}

/** Options for {@link Conductor.listModels}. */
export interface ListModelsOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Add `isFree` (heuristic fallback) and `raw` to every model. Default `false`. */
  details?: boolean;
}

/** Result of listing models for one provider. */
export interface ListModelsResult {
  ok: boolean;
  provider: ProviderId | string;
  models: ModelInfo[];
  error?: string;
}

/** Options for {@link Conductor.testProvider} / {@link Conductor.testProviders}. */
export interface ProviderTestOptions {
  /**
   * When `true`, send a real chat completion and require non-empty content.
   * When `false` / omitted, only check API key presence and the models endpoint.
   */
  real?: boolean;
  /** Prompt used when `real` is true (default: `Reply with exactly: ok`). */
  prompt?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Result of a provider connectivity or real chat probe. */
export interface ProviderTestResult {
  provider: ProviderId | string;
  ok: boolean;
  /** `connectivity` = key + models list; `real` = chat completion. */
  mode: 'connectivity' | 'real';
  ms: number;
  model?: string;
  /** Number of models returned by the catalog probe (connectivity mode). */
  modelsCount?: number;
  /** Short preview of the chat reply (real mode). */
  preview?: string;
  error?: string;
  checks?: {
    apiKeyPresent?: boolean;
    modelsEndpoint?: boolean;
    chatResponse?: boolean;
  };
}

/** Options for {@link Conductor.compressContext}. */
export interface CompressContextOptions extends ChatOptions {
  /**
   * How many recent user/assistant messages to keep verbatim.
   * Older turns are summarized into a system note. Default: `4`.
   */
  keepLast?: number;
  /** Override the instruction sent to the model that writes the summary. */
  summaryPrompt?: string;
}

/** Result of {@link Conductor.compressContext}. */
export interface CompressContextResult {
  /** Compressed dialog ready for the next {@link Conductor.chat} call. */
  messages: Message[];
  /** Summary text placed in the system message (empty when nothing was folded). */
  summary: string;
  /** Number of earlier non-system messages folded into the summary. */
  foldedCount: number;
  /** Provider that produced the summary, when a model call was made. */
  provider?: ProviderId | string;
  model?: string;
}

/**
 * Image source for {@link Conductor.recognizeImage}.
 * - `string`: `https://…` URL, `data:` URL, or a local file path (read from disk)
 * - `{ url }`: remote or `data:` URL
 * - `{ data, mimeType }`: raw bytes or a base64 string
 */
export type ImageInput =
  | string
  | { url: string; detail?: ImageDetail }
  | { data: Uint8Array | ArrayBuffer | string; mimeType: string; detail?: ImageDetail };

/** Options for {@link Conductor.recognizeImage}. */
export interface RecognizeImageOptions extends ChatOptions {
  /** Instruction for the model (default: describe the image in detail). */
  prompt?: string;
  /** Optional system message. */
  systemPrompt?: string;
  /** Default detail hint for images that do not set their own. */
  detail?: ImageDetail;
}

/** Vision capability of one provider, from {@link Conductor.getVisionCapabilities}. */
export interface VisionCapability {
  provider: ProviderId | string;
  label: string;
  /** Whether the provider API accepts image inputs for at least some models. */
  supportsVision: boolean;
  /** Known vision-capable model ids from the registry. */
  visionModels: string[];
  /** Whether the provider is present (and enabled) in the loaded config. */
  configured: boolean;
  /** Model the provider is configured with (or the registry default). */
  model?: string;
  /** Whether {@link model} is likely to accept images. */
  modelSupportsVision?: boolean;
  /**
   * Model {@link Conductor.recognizeImage} would use for this provider when no `model` is
   * passed: the configured model if it supports vision, otherwise the first `visionModels` entry.
   */
  recognitionModel?: string;
}
