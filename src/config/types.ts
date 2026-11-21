import type { ConductorError } from '../errors.js';
import type { GenerationParams, RoutingStrategy, TokenUsage } from '../types.js';
import type { ProviderId } from '../providers/registry.js';

/** One provider entry in YAML / init config. */
export interface ProviderConfig {
  /**
   * Built-in provider id (e.g. `gemini`, `groq`). With {@link provider} set, any instance id
   * (see {@link ProviderInstanceConfig}).
   */
  id: ProviderId;
  /** Provider type. When set, `id` is a free-form instance id. */
  provider?: ProviderId;
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
  /**
   * Whether this provider/model accepts `tools`. Overrides the registry `supportsTools`.
   * When `false`, the entry is skipped for requests that pass `tools`.
   */
  supportsTools?: boolean;
  /** Extra request headers (override built-in defaults such as OpenRouter `HTTP-Referer`). */
  headers?: Record<string, string>;
  /** Whether this provider/model accepts `reasoning_effort`. Overrides the registry. */
  supportsReasoningEffort?: boolean;
  /** Whether streaming requests send `stream_options.include_usage`. Overrides the registry. */
  supportsStreamUsage?: boolean;
}

/**
 * Provider entry with a free-form instance id (several profiles of the same provider type).
 *
 * @example
 * ```ts
 * { id: 'gemini-work', provider: 'gemini', apiKey: '…' }
 * ```
 */
export interface ProviderInstanceConfig extends Omit<ProviderConfig, 'id' | 'provider'> {
  /** Instance id used by `options.provider`, `fallback`, `apiKeys`, `dailyLimit` and usage. */
  id: string;
  /** Provider type. */
  provider: ProviderId;
}

/** Any provider entry: a built-in id, or an instance id with `provider`. */
export type AnyProviderConfig = ProviderConfig | ProviderInstanceConfig;

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
  providers: AnyProviderConfig[];
  routing?: RoutingConfig;
  /** Ordered fallback provider ids tried after primary candidates fail. */
  fallback?: Array<ProviderId | string>;
  defaults?: GenerationParams & {
    model?: string;
    timeoutMs?: number;
  };
}

/** Config after normalization: every entry has its provider type in `provider`. */
export interface NormalizedConductorConfig extends Omit<ConductorConfig, 'providers'> {
  providers: ProviderInstanceConfig[];
}

/**
 * Environment source for API keys and `${VAR}` expansion:
 * `true` = `process.env` (default), `false` = none, or an explicit map.
 */
export type EnvSource = boolean | Record<string, string | undefined>;

/** Persisted daily usage counter for one instance. */
export interface UsageState {
  /** UTC day key `YYYY-MM-DD`. */
  day: string;
  count: number;
}

/** Pluggable store for daily usage counters (default: in memory). */
export interface UsageStore {
  get(id: string): UsageState | undefined;
  set(id: string, state: UsageState): void;
  /** Optional: drop state for an instance removed by `updateConfig`. */
  delete?(id: string): void;
}

/** Event passed to {@link ConductorInitOptions.onResponse} after every HTTP attempt. */
export interface ConductorResponseEvent {
  /** Provider instance id. */
  provider: string;
  providerType: ProviderId;
  model?: string;
  /** HTTP status (`0` for network errors / aborts). */
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  usage?: TokenUsage;
  durationMs: number;
  error?: ConductorError;
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
  /**
   * Where API keys and `${VAR}` placeholders come from. Default `true` (`process.env`).
   * Embedded hosts should pass `false`: no env lookup and `${VAR}` is left as is.
   */
  env?: EnvSource;
  /** Called after every HTTP attempt (success or failure). Errors thrown here are ignored. */
  onResponse?: (event: ConductorResponseEvent) => void;
  /** Persist daily usage counters (default: in memory). */
  usageStore?: UsageStore;
}

/** Partial config accepted by {@link Conductor.updateConfig}. */
export type ConductorConfigUpdate = Partial<ConductorConfig> & {
  apiKeys?: ConductorInitOptions['apiKeys'];
};
