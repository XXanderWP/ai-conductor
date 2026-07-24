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
