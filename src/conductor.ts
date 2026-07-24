import { loadConfigFile, mergeConfig, resolveApiKey } from './config/load.js';
import type { ConductorConfig, ConductorInitOptions, ProviderConfig } from './config/types.js';
import {
  openaiChatCompletion,
  openaiListModels,
  type ResolvedProviderEndpoint,
} from './providers/openai-client.js';
import {
  isProviderId,
  PROVIDERS,
  type ProviderId,
  type ProviderMeta,
} from './providers/registry.js';
import { orderProviders } from './routing/order.js';
import { DailyUsageTracker } from './routing/usage.js';
import type {
  ChatOptions,
  ChatResponse,
  ListModelsResult,
  Message,
  ProviderTestOptions,
  ProviderTestResult,
  RoutingStrategy,
} from './types.js';
import { normalizeMessages } from './utils.js';
import { formatSuggestions } from './utils/suggest.js';

const DEFAULT_TEST_PROMPT = 'Reply with exactly: ok';
const DEFAULT_CONNECTIVITY_TIMEOUT_MS = 15_000;

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
   * All built-in providers from the registry (not filtered by config).
   */
  getAvailableProviders(): ProviderMeta[] {
    return Object.values(PROVIDERS);
  }

  /**
   * Providers declared in the loaded config (including disabled entries).
   */
  getConfiguredProviders(): ProviderConfig[] {
    return this.getConfig().providers.slice();
  }

  /**
   * Fetch and parse available models for a configured provider via `GET /models`
   * (with Puter / Ollama fallbacks where needed).
   */
  async listModels(providerId: string, options?: { timeoutMs?: number }): Promise<ListModelsResult>;
  /**
   * Fetch and parse available models for every enabled configured provider.
   */
  async listModels(options?: { timeoutMs?: number }): Promise<ListModelsResult[]>;
  async listModels(
    providerIdOrOptions?: string | { timeoutMs?: number },
    options?: { timeoutMs?: number },
  ): Promise<ListModelsResult | ListModelsResult[]> {
    await this.ready;

    if (typeof providerIdOrOptions === 'string') {
      return this.listModelsForProvider(providerIdOrOptions, options?.timeoutMs);
    }

    const timeoutMs = providerIdOrOptions?.timeoutMs ?? options?.timeoutMs;
    const results: ListModelsResult[] = [];
    for (const entry of this.config.providers) {
      if (entry.enabled === false) continue;
      results.push(await this.listModelsForProvider(entry.id, timeoutMs));
    }
    return results;
  }

  /**
   * Probe a configured provider.
   *
   * - `real: false` / omitted — check API key presence and the models catalog.
   * - `real: true` — send a short chat completion and require non-empty content.
   */
  async testProvider(
    providerId: string,
    options?: ProviderTestOptions,
  ): Promise<ProviderTestResult> {
    await this.ready;
    this.assertProviderOption(providerId);

    const started = Date.now();
    const timeoutMs = options?.timeoutMs;
    const providerConfig = this.config.providers.find((p) => p.id === providerId)!;
    const endpoint = this.toEndpoint(providerConfig);
    const meta = PROVIDERS[providerConfig.id];
    const apiKeyPresent = !meta.requiresApiKey || Boolean(endpoint.apiKey);

    if (options?.real) {
      return this.runRealProviderTest(providerId, endpoint, started, {
        prompt: options.prompt,
        timeoutMs,
        apiKeyPresent,
      });
    }

    return this.runConnectivityProviderTest(providerId, endpoint, started, {
      timeoutMs,
      apiKeyPresent,
    });
  }

  /**
   * Probe every enabled configured provider (same options as {@link testProvider}).
   */
  async testProviders(options?: ProviderTestOptions): Promise<ProviderTestResult[]> {
    await this.ready;
    const results: ProviderTestResult[] = [];
    for (const entry of this.config.providers) {
      if (entry.enabled === false) continue;
      results.push(await this.testProvider(entry.id, options));
    }
    return results;
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

    if (options?.provider) {
      this.assertProviderOption(options.provider);
    }

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

  private async listModelsForProvider(
    providerId: string,
    timeoutMs?: number,
  ): Promise<ListModelsResult> {
    this.assertProviderConfigured(providerId);
    const providerConfig = this.config.providers.find((p) => p.id === providerId)!;
    const endpoint = this.toEndpoint(providerConfig);
    const listed = await openaiListModels(
      endpoint,
      timeoutMs ?? DEFAULT_CONNECTIVITY_TIMEOUT_MS,
      this.fetchImpl,
    );

    if (!listed.ok) {
      return {
        ok: false,
        provider: providerId,
        models: [],
        error: listed.error,
      };
    }

    return {
      ok: true,
      provider: providerId,
      models: listed.models,
    };
  }

  private async runConnectivityProviderTest(
    providerId: string,
    endpoint: ResolvedProviderEndpoint,
    started: number,
    options: { timeoutMs?: number; apiKeyPresent: boolean },
  ): Promise<ProviderTestResult> {
    if (!options.apiKeyPresent) {
      return {
        provider: providerId,
        ok: false,
        mode: 'connectivity',
        ms: Date.now() - started,
        error: `API key required for provider "${providerId}".`,
        checks: { apiKeyPresent: false, modelsEndpoint: false },
      };
    }

    const listed = await openaiListModels(
      endpoint,
      options.timeoutMs ?? DEFAULT_CONNECTIVITY_TIMEOUT_MS,
      this.fetchImpl,
    );

    if (!listed.ok) {
      return {
        provider: providerId,
        ok: false,
        mode: 'connectivity',
        ms: Date.now() - started,
        error: listed.error,
        checks: { apiKeyPresent: true, modelsEndpoint: false },
      };
    }

    return {
      provider: providerId,
      ok: true,
      mode: 'connectivity',
      ms: Date.now() - started,
      modelsCount: listed.models.length,
      checks: { apiKeyPresent: true, modelsEndpoint: true },
    };
  }

  private async runRealProviderTest(
    providerId: string,
    endpoint: ResolvedProviderEndpoint,
    started: number,
    options: { prompt?: string; timeoutMs?: number; apiKeyPresent: boolean },
  ): Promise<ProviderTestResult> {
    if (!options.apiKeyPresent) {
      return {
        provider: providerId,
        ok: false,
        mode: 'real',
        ms: Date.now() - started,
        error: `API key required for provider "${providerId}".`,
        checks: { apiKeyPresent: false, chatResponse: false },
      };
    }

    const prompt = options.prompt?.trim() || DEFAULT_TEST_PROMPT;
    const result = await openaiChatCompletion(
      endpoint,
      [{ role: 'user', content: prompt }],
      {
        model: endpoint.model,
        timeoutMs: options.timeoutMs ?? this.config.defaults?.timeoutMs,
        maxTokens: 16,
        temperature: 0,
      },
      this.fetchImpl,
    );

    if (!result.ok) {
      return {
        provider: providerId,
        ok: false,
        mode: 'real',
        ms: Date.now() - started,
        error: result.error.message,
        checks: { apiKeyPresent: true, chatResponse: false },
      };
    }

    const content = result.data.content.trim();
    if (!content) {
      return {
        provider: providerId,
        ok: false,
        mode: 'real',
        ms: Date.now() - started,
        model: result.data.model,
        error: 'Provider returned an empty response.',
        checks: { apiKeyPresent: true, chatResponse: false },
      };
    }

    this.usage.record(providerId);
    return {
      provider: providerId,
      ok: true,
      mode: 'real',
      ms: Date.now() - started,
      model: result.data.model,
      preview: content.replace(/\s+/g, ' ').slice(0, 120),
      checks: { apiKeyPresent: true, chatResponse: true },
    };
  }

  private assertProviderConfigured(providerId: string): void {
    const configuredIds = this.config.providers.map((p) => p.id);
    const knownIds = Object.keys(PROVIDERS);

    if (!isProviderId(providerId)) {
      throw new Error(
        `Unknown provider id "${providerId}". ${formatSuggestions(providerId, knownIds)}`,
      );
    }

    if (!configuredIds.includes(providerId)) {
      throw new Error(
        `Provider "${providerId}" is not in the current config. ${formatSuggestions(providerId, configuredIds)}`,
      );
    }
  }

  private assertProviderOption(providerId: string): void {
    this.assertProviderConfigured(providerId);

    const entry = this.config.providers.find((p) => p.id === providerId);
    if (entry?.enabled === false) {
      throw new Error(`Provider "${providerId}" is disabled in the config.`);
    }

    if (this.usage.isExhausted(providerId, entry?.dailyLimit)) {
      throw new Error(`Provider "${providerId}" reached its dailyLimit (${entry?.dailyLimit}).`);
    }
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
