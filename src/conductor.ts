import { loadConfigFile, mergeConfig, resolveApiKey } from './config/load.js';
import type { ConductorConfig, ConductorInitOptions, ProviderConfig } from './config/types.js';
import { openaiChatCompletion, type ResolvedProviderEndpoint } from './providers/openai-client.js';
import { PROVIDERS, type ProviderId } from './providers/registry.js';
import { orderProviders } from './routing/order.js';
import { DailyUsageTracker } from './routing/usage.js';
import type { ChatOptions, ChatResponse, Message, RoutingStrategy } from './types.js';
import { normalizeMessages } from './utils.js';

/**
 * Orchestrate any AI provider through one API.
 *
 * Load a YAML config and/or pass inline options, then call {@link chat}.
 *
 * @example
 * ```ts
 * const conductor = new Conductor({ configPath: './config.yml' });
 * const response = await conductor.chat([{ role: 'user', content: 'Hello' }]);
 * ```
 */
export class Conductor {
  private config!: ConductorConfig;
  private readonly init: ConductorInitOptions;
  private readonly usage: DailyUsageTracker;
  private readonly fetchImpl: typeof globalThis.fetch;
  private ready: Promise<void>;
  private roundRobinIndex = 0;

  constructor(options: ConductorInitOptions = {}) {
    this.init = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.usage = new DailyUsageTracker(options.now ?? (() => Date.now()));
    this.ready = this.bootstrap();
  }

  /** Wait until config is loaded (also awaited automatically by {@link chat}). */
  async whenReady(): Promise<void> {
    await this.ready;
  }

  /** Resolved configuration (after load/merge). */
  getConfig(): ConductorConfig {
    if (!this.config) {
      throw new Error('Conductor is not ready yet. Await whenReady() or chat().');
    }
    return this.config;
  }

  /** Active routing strategy. */
  getStrategy(): RoutingStrategy {
    return this.getConfig().routing?.strategy ?? 'cheapest';
  }

  /** Soft daily usage count for a provider (UTC day). */
  getDailyUsage(providerId: string): number {
    return this.usage.getCount(providerId);
  }

  /**
   * Chat with the configured providers using the active routing strategy.
   * @param input Plain string or message list.
   * @param options Per-request overrides.
   */
  async chat(input: string | Message[], options?: ChatOptions): Promise<ChatResponse> {
    await this.ready;
    const messages = normalizeMessages(input);
    const strategy = this.getStrategy();

    const { ordered, nextRoundRobinIndex } = orderProviders({
      providers: this.config.providers,
      strategy,
      fallback: this.config.fallback,
      usage: this.usage,
      roundRobinIndex: this.roundRobinIndex,
      forcedId: options?.provider,
    });
    this.roundRobinIndex = nextRoundRobinIndex;

    if (ordered.length === 0) {
      throw new Error('No eligible providers (all disabled or daily limits reached).');
    }

    const failedProviders: string[] = [];
    let lastError: string | undefined;

    for (const providerConfig of ordered) {
      const endpoint = this.toEndpoint(providerConfig);
      const result = await openaiChatCompletion(
        endpoint,
        messages,
        {
          ...options,
          model: options?.model ?? endpoint.model,
          timeoutMs: options?.timeoutMs ?? this.config.defaults?.timeoutMs,
          temperature: options?.temperature ?? this.config.defaults?.temperature,
          topP: options?.topP ?? this.config.defaults?.topP,
          maxTokens: options?.maxTokens ?? this.config.defaults?.maxTokens,
        },
        this.fetchImpl,
      );

      if (result.ok) {
        this.usage.record(providerConfig.id);
        return {
          content: result.data.content,
          provider: providerConfig.id,
          model: result.data.model,
          usage: result.data.usage,
          strategy,
          failedProviders: failedProviders.length ? failedProviders : undefined,
          raw: result.data.raw,
        };
      }

      failedProviders.push(providerConfig.id);
      lastError = result.error.message;

      // Non-retryable auth/config errors: still try fallbacks, but do not loop forever.
      if (!result.error.retryable && !result.error.rateLimited && ordered.length === 1) {
        break;
      }
    }

    throw new Error(
      `All providers failed (${failedProviders.join(' → ') || 'none'}). Last error: ${lastError ?? 'unknown'}`,
    );
  }

  private async bootstrap(): Promise<void> {
    let fileConfig: ConductorConfig | undefined;
    if (this.init.configPath) {
      fileConfig = await loadConfigFile(this.init.configPath);
    }
    this.config = mergeConfig(fileConfig, this.init);
  }

  private toEndpoint(providerConfig: ProviderConfig): ResolvedProviderEndpoint {
    const meta = PROVIDERS[providerConfig.id];
    const apiKey = resolveApiKey(providerConfig.id, providerConfig.apiKey, this.init.apiKeys);
    const model =
      providerConfig.model?.trim() ||
      this.config.defaults?.model?.trim() ||
      meta.suggestedModels?.[0] ||
      '';

    return {
      id: providerConfig.id,
      model,
      apiKey,
      baseUrl: providerConfig.baseUrl ?? meta.defaultBaseUrl,
      params: {
        ...this.config.defaults,
        ...providerConfig.params,
      },
    };
  }
}

/** @deprecated Use {@link Conductor}. Kept for early 0.1 compatibility. */
export { Conductor as AIConductor };

export type { ProviderId };
