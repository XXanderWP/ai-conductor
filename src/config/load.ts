import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ConductorConfig, ConductorInitOptions, ProviderConfig } from './types.js';
import { isProviderId, PROVIDERS, type ProviderId } from '../providers/registry.js';
import type { GenerationParams, RoutingStrategy } from '../types.js';

const ROUTING_STRATEGIES: RoutingStrategy[] = [
  'cheapest',
  'priority',
  'round-robin',
  'failover',
  'first-available',
];

/** Expand `${VAR}` / `$VAR` placeholders from `process.env`. */
export function interpolateEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/gi, (_, braced, bare) => {
    const key = (braced ?? bare) as string;
    return process.env[key] ?? '';
  });
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

function normalizeProvider(raw: unknown, index: number): ProviderConfig {
  const src = asRecord(raw);
  const id = src.id;
  if (!isProviderId(id)) {
    throw new Error(
      `Invalid provider id at providers[${index}]: ${String(id)}. Known: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }

  const apiKey = typeof src.apiKey === 'string' ? interpolateEnv(src.apiKey) : undefined;
  const model = typeof src.model === 'string' ? interpolateEnv(src.model) : undefined;
  const baseUrl = typeof src.baseUrl === 'string' ? interpolateEnv(src.baseUrl) : undefined;

  return {
    id,
    priority: typeof src.priority === 'number' ? src.priority : undefined,
    dailyLimit: typeof src.dailyLimit === 'number' ? Math.floor(src.dailyLimit) : undefined,
    apiKey: apiKey || undefined,
    model: model || undefined,
    baseUrl: baseUrl || undefined,
    enabled: src.enabled === false ? false : true,
    isPaid: src.isPaid === true,
    params: normalizeParams(src.params),
  };
}

function normalizeStrategy(raw: unknown): RoutingStrategy {
  if (typeof raw === 'string' && ROUTING_STRATEGIES.includes(raw as RoutingStrategy)) {
    return raw as RoutingStrategy;
  }
  return 'cheapest';
}

/** Normalize a raw YAML/JSON object into {@link ConductorConfig}. */
export function normalizeConfig(raw: unknown): ConductorConfig {
  const src = asRecord(raw);
  if (!Array.isArray(src.providers) || src.providers.length === 0) {
    throw new Error('Config must declare at least one entry in `providers`.');
  }

  const providers = src.providers.map((p, i) => normalizeProvider(p, i));
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
export async function loadConfigFile(configPath: string): Promise<ConductorConfig> {
  const absolute = path.resolve(configPath);
  const text = await readFile(absolute, 'utf8');
  const parsed = parseYaml(text);
  return normalizeConfig(parsed);
}

/**
 * Merge file config with inline init options.
 * Inline `providers` / `routing` / `fallback` / `defaults` override file values.
 */
export function mergeConfig(
  fileConfig: ConductorConfig | undefined,
  init: ConductorInitOptions,
): ConductorConfig {
  const base: ConductorConfig = fileConfig ?? {
    providers: [],
    routing: { strategy: 'cheapest' },
  };

  const providers =
    init.providers && init.providers.length > 0
      ? init.providers.map((p, i) => normalizeProvider(p, i))
      : base.providers;

  if (providers.length === 0) {
    throw new Error('No providers configured. Pass `configPath` or `providers` to Conductor.');
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

/** Resolve an API key from config, init map, or environment. */
export function resolveApiKey(
  provider: ProviderId,
  fromConfig?: string,
  apiKeys?: ConductorInitOptions['apiKeys'],
): string {
  if (fromConfig?.trim()) {
    return fromConfig.trim();
  }
  const fromMap = apiKeys?.[provider]?.trim();
  if (fromMap) {
    return fromMap;
  }

  const specific = process.env[`AI_CONDUCTOR_${provider.toUpperCase()}_API_KEY`]?.trim();
  if (specific) {
    return specific;
  }

  for (const alias of ENV_ALIASES[provider] ?? []) {
    const value = process.env[alias]?.trim();
    if (value) {
      return value;
    }
  }

  return '';
}
