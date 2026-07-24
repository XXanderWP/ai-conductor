import type { GenerationParams, RoutingStrategy } from '../types.js';
import type { ProviderId } from '../providers/registry.js';

/** One provider entry in YAML / init config. */
export interface ProviderConfig {
  /** Built-in provider id (e.g. `gemini`, `groq`). */
  id: ProviderId;
  /**
   * Higher values are preferred for `priority` / `cheapest` strategies.
   * Defaults to `1000 - autoPriority * 10` from the registry.
   */
  priority?: number;
  /** Soft daily request cap; when reached the provider is skipped until UTC day reset. */
  dailyLimit?: number;
  /** API key (optional if provided via `apiKeys` / env). */
  apiKey?: string;
  /** Model id. Falls back to the first suggested model for the provider. */
  model?: string;
  /** Optional OpenAI-compatible base URL override. */
  baseUrl?: string;
  /** When false, provider is ignored. Default true. */
  enabled?: boolean;
  /** When true, skipped by `cheapest` unless no free providers remain. */
  isPaid?: boolean;
  /** Default generation params for this provider. */
  params?: GenerationParams;
}

/** Routing section of the config. */
export interface RoutingConfig {
  strategy?: RoutingStrategy;
}

/**
 * Declarative conductor configuration (YAML or object).
 *
 * @example
 * ```yaml
 * providers:
 *   - id: gemini
 *     priority: 100
 *     dailyLimit: 1000
 *   - id: groq
 *     priority: 90
 * routing:
 *   strategy: cheapest
 * fallback:
 *   - gemini
 *   - groq
 *   - openrouter
 * ```
 */
export interface ConductorConfig {
  providers: ProviderConfig[];
  routing?: RoutingConfig;
  /** Ordered fallback provider ids tried after primary candidates fail. */
  fallback?: Array<ProviderId | string>;
  defaults?: GenerationParams & {
    model?: string;
    timeoutMs?: number;
  };
}

/** Options passed to `new Conductor(...)`. */
export interface ConductorInitOptions extends Partial<ConductorConfig> {
  /** Path to a YAML config file. Merged with inline options (inline wins). */
  configPath?: string;
  /**
   * API keys keyed by provider id.
   * Also reads `AI_CONDUCTOR_<ID>_API_KEY` and common vendor env vars.
   */
  apiKeys?: Partial<Record<ProviderId, string>> & Record<string, string>;
  /** Injected fetch implementation (tests). */
  fetch?: typeof globalThis.fetch;
  /** Injected clock (tests). */
  now?: () => number;
}
