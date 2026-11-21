import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  ConductorConfig,
  ConductorInitOptions,
  EnvSource,
  NormalizedConductorConfig,
  ProviderInstanceConfig,
} from './types.js';
import { ConductorError } from '../errors.js';
import { isProviderId, PROVIDERS, type ProviderId } from '../providers/registry.js';
import type { GenerationParams, RoutingStrategy } from '../types.js';

const ROUTING_STRATEGIES: RoutingStrategy[] = [
  'cheapest',
  'priority',
  'round-robin',
  'failover',
  'first-available',
];

/** Options shared by config loading helpers. */
export interface ConfigEnvOptions {
  /** Env source (default `true` = `process.env`; `false` = no lookup, placeholders kept). */
  env?: EnvSource;
}

/** Resolve an {@link EnvSource} to a lookup map, or `undefined` when env access is disabled. */
export function resolveEnv(
  env: EnvSource | undefined,
): Record<string, string | undefined> | undefined {
  if (env === false) return undefined;
  if (env === undefined || env === true) return process.env;
  return env;
}

/**
 * Expand `${VAR}` / `$VAR` placeholders from `process.env` (or `options.env`).
 * With `env: false` the value is returned unchanged.
 */
export function interpolateEnv(value: string, options?: ConfigEnvOptions): string {
  const source = resolveEnv(options?.env);
  if (!source) return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/gi, (_, braced, bare) => {
    const key = (braced ?? bare) as string;
    return source[key] ?? '';
  });
}

function configError(message: string): ConductorError {
  return new ConductorError(message, { code: 'config' });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeParams(raw: unknown): GenerationParams | undefined {
  const src = asRecord(raw);
  const out: GenerationParams = {};
  if (typeof src.temperature === 'number') out.temperature = src.temperature;
  if (typeof src.topP === 'number') out.topP = src.topP;
  if (typeof src.maxTokens === 'number') out.maxTokens = Math.floor(src.maxTokens);
  if (typeof src.frequencyPenalty === 'number') out.frequencyPenalty = src.frequencyPenalty;
  if (typeof src.presencePenalty === 'number') out.presencePenalty = src.presencePenalty;
  if (Array.isArray(src.stop)) {
    out.stop = src.stop.filter((s): s is string => typeof s === 'string');
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeHeaders(
  raw: unknown,
  options?: ConfigEnvOptions,
): Record<string, string> | undefined {
  const src = asRecord(raw);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(src)) {
    if (typeof value === 'string') out[key.toLowerCase()] = interpolateEnv(value, options);
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeProvider(
  raw: unknown,
  index: number,
  options?: ConfigEnvOptions,
): ProviderInstanceConfig {
  const src = asRecord(raw);
  const id = src.id;
  const known = Object.keys(PROVIDERS).join(', ');
  let provider: ProviderId;
  if (src.provider !== undefined) {
    if (!isProviderId(src.provider)) {
      throw configError(
        `Invalid provider type at providers[${index}].provider: ${String(src.provider)}. Known: ${known}`,
      );
    }
    if (typeof id !== 'string' || !id.trim()) {
      throw configError(`providers[${index}].id must be a non-empty instance id.`);
    }
    provider = src.provider;
  } else {
    if (!isProviderId(id)) {
      throw configError(
        `Invalid provider id at providers[${index}]: ${String(id)}. Known: ${known} (or set \`provider\` to use a custom instance id).`,
      );
    }
    provider = id;
  }

  const apiKey = typeof src.apiKey === 'string' ? interpolateEnv(src.apiKey, options) : undefined;
  const model = typeof src.model === 'string' ? interpolateEnv(src.model, options) : undefined;
  const baseUrl =
    typeof src.baseUrl === 'string' ? interpolateEnv(src.baseUrl, options) : undefined;
  const flag = (value: unknown) => (typeof value === 'boolean' ? value : undefined);

  return {
    id: (id as string).trim(),
    provider,
    priority: typeof src.priority === 'number' ? src.priority : undefined,
    dailyLimit: typeof src.dailyLimit === 'number' ? Math.floor(src.dailyLimit) : undefined,
    apiKey: apiKey || undefined,
    model: model || undefined,
    baseUrl: baseUrl || undefined,
    enabled: src.enabled === false ? false : true,
    isPaid: src.isPaid === true,
    params: normalizeParams(src.params),
    supportsTools: flag(src.supportsTools),
    headers: normalizeHeaders(src.headers, options),
    supportsReasoningEffort: flag(src.supportsReasoningEffort),
    supportsStreamUsage: flag(src.supportsStreamUsage),
  };
}

function normalizeProviders(list: unknown[], options?: ConfigEnvOptions): ProviderInstanceConfig[] {
  return assertUniqueIds(list.map((p, i) => normalizeProvider(p, i, options)));
}

function assertUniqueIds(providers: ProviderInstanceConfig[]): ProviderInstanceConfig[] {
  const seen = new Set<string>();
  for (const entry of providers) {
    if (seen.has(entry.id)) {
      throw configError(`Duplicate provider instance id "${entry.id}" in \`providers\`.`);
    }
    seen.add(entry.id);
  }
  return providers;
}

function normalizeStrategy(raw: unknown): RoutingStrategy {
  if (typeof raw === 'string' && ROUTING_STRATEGIES.includes(raw as RoutingStrategy)) {
    return raw as RoutingStrategy;
  }
  return 'cheapest';
}

/** Normalize a raw YAML/JSON object into {@link ConductorConfig}. */
export function normalizeConfig(
  raw: unknown,
  options?: ConfigEnvOptions,
): NormalizedConductorConfig {
  const src = asRecord(raw);
  if (!Array.isArray(src.providers) || src.providers.length === 0) {
    throw configError('Config must declare at least one entry in `providers`.');
  }

  const providers = normalizeProviders(src.providers, options);
  const routingRaw = asRecord(src.routing);
  const defaultsRaw = asRecord(src.defaults);

  const fallback = Array.isArray(src.fallback)
    ? src.fallback.filter((id): id is string => typeof id === 'string')
    : undefined;

  return {
    providers,
    routing: { strategy: normalizeStrategy(routingRaw.strategy) },
    fallback,
    defaults: {
      ...normalizeParams(defaultsRaw),
      model: typeof defaultsRaw.model === 'string' ? defaultsRaw.model : undefined,
      timeoutMs:
        typeof defaultsRaw.timeoutMs === 'number' ? Math.floor(defaultsRaw.timeoutMs) : undefined,
    },
  };
}

/** Load and parse a YAML config file from disk. */
export async function loadConfigFile(
  configPath: string,
  options?: ConfigEnvOptions,
): Promise<NormalizedConductorConfig> {
  const absolute = path.resolve(configPath);
  const text = await readFile(absolute, 'utf8');
  const parsed = parseYaml(text);
  return normalizeConfig(parsed, options);
}

/**
 * Merge file config with inline init options.
 * Inline `providers` / `routing` / `fallback` / `defaults` override file values.
 */
export function mergeConfig(
  fileConfig: ConductorConfig | undefined,
  init: ConductorInitOptions,
): NormalizedConductorConfig {
  const base: ConductorConfig = fileConfig ?? {
    providers: [],
    routing: { strategy: 'cheapest' },
  };
  const envOptions = { env: init.env };

  const providers =
    init.providers && init.providers.length > 0
      ? normalizeProviders(init.providers, envOptions)
      : assertUniqueIds(
          base.providers.map((p) => ({ ...p, provider: p.provider ?? (p.id as ProviderId) })),
        );

  if (providers.length === 0) {
    throw configError('No providers configured. Pass `configPath` or `providers` to Conductor.');
  }

  return {
    providers,
    routing: {
      strategy: init.routing?.strategy ?? base.routing?.strategy ?? 'cheapest',
    },
    fallback: init.fallback ?? base.fallback,
    defaults: {
      ...base.defaults,
      ...init.defaults,
    },
  };
}

/** Common env var aliases for provider API keys. */
const ENV_ALIASES: Partial<Record<ProviderId, string[]>> = {
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  nvidia: ['NVIDIA_API_KEY', 'NGC_API_KEY'],
  github: ['GITHUB_TOKEN', 'GH_TOKEN'],
  zai: ['ZAI_API_KEY', 'Z_AI_API_KEY'],
  puter: ['PUTER_API_KEY'],
  opencode: ['OPENCODE_API_KEY'],
  huggingface: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  cohere: ['COHERE_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  openai_compatible: ['OPENAI_API_KEY'],
};

/** Options for {@link resolveApiKey}. */
export interface ResolveApiKeyOptions extends ConfigEnvOptions {
  /** Instance id; looked up in `apiKeys` / `AI_CONDUCTOR_<ID>_API_KEY` before the type. */
  instanceId?: string;
}

function envKeyName(id: string): string {
  return `AI_CONDUCTOR_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

/**
 * Resolve an API key from config, the init `apiKeys` map (instance id, then provider type),
 * or the environment (skipped with `env: false`).
 */
export function resolveApiKey(
  provider: ProviderId,
  fromConfig?: string,
  apiKeys?: ConductorInitOptions['apiKeys'],
  options?: ResolveApiKeyOptions,
): string {
  if (fromConfig?.trim()) {
    return fromConfig.trim();
  }
  const instanceId = options?.instanceId;
  const ids = instanceId && instanceId !== provider ? [instanceId, provider] : [provider];
  for (const id of ids) {
    const fromMap = apiKeys?.[id]?.trim();
    if (fromMap) return fromMap;
  }

  const env = resolveEnv(options?.env);
  if (!env) return '';

  for (const id of ids) {
    const specific = env[envKeyName(id)]?.trim();
    if (specific) return specific;
  }

  for (const alias of ENV_ALIASES[provider] ?? []) {
    const value = env[alias]?.trim();
    if (value) {
      return value;
    }
  }

  return '';
}
