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

/** A single chat message. Use content parts to send images to vision-capable models. */
export interface Message {
  role: MessageRole;
  content: string | MessageContentPart[];
}

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
  /** Request timeout in milliseconds (default 120_000). */
  timeoutMs?: number;
  /** Extra OpenAI-compatible body fields. */
  metadata?: Record<string, unknown>;
}

/** Token usage when reported by the provider. */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** Successful chat response from {@link Conductor.chat}. */
export interface ChatResponse {
  content: string;
  provider: ProviderId | string;
  model?: string;
  usage?: TokenUsage;
  /** Routing strategy that selected the provider. */
  strategy: RoutingStrategy;
  /** Providers that failed before success. */
  failedProviders?: string[];
  /** Raw provider JSON body when available. */
  raw?: unknown;
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
