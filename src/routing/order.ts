import type { ProviderConfig } from '../config/types.js';
import { isLikelyFreeModel, PROVIDERS, type ProviderId } from '../providers/registry.js';
import type { RoutingStrategy } from '../types.js';
import type { DailyUsageTracker } from './usage.js';

export interface RankedProvider {
  config: ProviderConfig;
  score: number;
}

function defaultPriority(id: ProviderId): number {
  return 1000 - PROVIDERS[id].autoPriority * 10;
}

function effectivePriority(config: ProviderConfig): number {
  return config.priority ?? defaultPriority(config.id);
}

function looksCheap(config: ProviderConfig): boolean {
  if (config.isPaid) return false;
  const meta = PROVIDERS[config.id];
  const model = config.model ?? meta.suggestedModels?.[0] ?? '';
  if (!model) return meta.defaultFree;
  return isLikelyFreeModel(config.id, model);
}

/**
 * Score a provider for the `cheapest` strategy (higher = better).
 * Prefers free-tier providers, then config priority, then registry autoPriority.
 */
export function scoreCheapest(config: ProviderConfig): number {
  let score = effectivePriority(config);
  if (looksCheap(config)) score += 10_000;
  if (PROVIDERS[config.id].defaultFree && !config.isPaid) score += 1_000;
  score -= PROVIDERS[config.id].autoPriority;
  return score;
}

export function scorePriority(config: ProviderConfig): number {
  return effectivePriority(config);
}

/**
 * Build an ordered candidate list according to strategy, then append unique fallback ids.
 */
export function orderProviders(options: {
  providers: ProviderConfig[];
  strategy: RoutingStrategy;
  fallback?: string[];
  usage: DailyUsageTracker;
  roundRobinIndex: number;
  forcedId?: string;
}): { ordered: ProviderConfig[]; nextRoundRobinIndex: number } {
  const enabled = options.providers.filter((p) => p.enabled !== false);
  const available = enabled.filter((p) => !options.usage.isExhausted(p.id, p.dailyLimit));

  if (options.forcedId) {
    const forced = available.find((p) => p.id === options.forcedId);
    if (!forced) {
      throw new Error(
        `Provider "${options.forcedId}" is not available (missing, disabled, or daily limit reached).`,
      );
    }
    return { ordered: [forced], nextRoundRobinIndex: options.roundRobinIndex };
  }

  let primary: ProviderConfig[] = [];
  let nextRoundRobinIndex = options.roundRobinIndex;

  switch (options.strategy) {
    case 'first-available':
      primary = available.slice(0, 1);
      break;
    case 'failover':
      primary = [...available];
      break;
    case 'round-robin': {
      if (available.length === 0) {
        primary = [];
        break;
      }
      const start = options.roundRobinIndex % available.length;
      primary = [...available.slice(start), ...available.slice(0, start)];
      nextRoundRobinIndex = (start + 1) % available.length;
      break;
    }
    case 'priority':
      primary = [...available].sort((a, b) => scorePriority(b) - scorePriority(a));
      break;
    case 'cheapest':
    default:
      primary = [...available].sort((a, b) => scoreCheapest(b) - scoreCheapest(a));
      break;
  }

  const seen = new Set(primary.map((p) => p.id));
  const fallbackConfigs: ProviderConfig[] = [];
  for (const id of options.fallback ?? []) {
    if (seen.has(id as ProviderId)) continue;
    const match = available.find((p) => p.id === id);
    if (match) {
      fallbackConfigs.push(match);
      seen.add(match.id);
    }
  }

  return { ordered: [...primary, ...fallbackConfigs], nextRoundRobinIndex };
}
