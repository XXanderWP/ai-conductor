/**
 * Shared message and chat option types.
 */

import type { ProviderId } from './providers/registry.js';

/** Chat message role. */
export type MessageRole = 'system' | 'user' | 'assistant';

/** A single chat message. */
export interface Message {
  role: MessageRole;
  content: string;
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
