import { loadConfigFile, mergeConfig, resolveApiKey } from './config/load.js';
import type { ConductorConfig, ConductorInitOptions, ProviderConfig } from './config/types.js';
import {
  openaiChatCompletion,
  openaiChatCompletionStream,
  openaiListModels,
  type ResolvedProviderEndpoint,
} from './providers/openai-client.js';
import {
  isLikelyVisionModel,
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
  ChatStreamChunkCallback,
  ChatStreamHandle,
  ChatStreamOptions,
  CompressContextOptions,
  CompressContextResult,
  ImageInput,
  ListModelsResult,
  Message,
  MessageContentPart,
  ProviderTestOptions,
  ProviderTestResult,
  RecognizeImageOptions,
  RoutingStrategy,
  VisionCapability,
} from './types.js';
import { messageText, normalizeMessages } from './utils.js';
import { toImageContentPart } from './vision.js';
import { formatSuggestions } from './utils/suggest.js';

const DEFAULT_TEST_PROMPT = 'Reply with exactly: ok';
const DEFAULT_CONNECTIVITY_TIMEOUT_MS = 15_000;
const DEFAULT_KEEP_LAST = 4;
const DEFAULT_RECOGNIZE_PROMPT = 'Describe this image in detail.';

/** One routing candidate with an optional model override. */
interface ChatCandidate {
  config: ProviderConfig;
  model?: string;
}

const DEFAULT_SUMMARY_PROMPT = [
  'Summarize the following conversation so it can replace the earlier turns.',
  'Capture the topic, key facts, decisions, open questions, and user preferences.',
  'Write in the same language as the conversation. Be concise but complete.',
  'Do not continue the dialogue. Reply with the summary only.',
].join(' ');

/**
 * Orchestrate any AI provider through one API.
 *
 * Load a YAML config and/or pass inline options, then call {@link chat} or {@link chatStream}.
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

  /** Wait until config is loaded (also awaited automatically by {@link chat} / {@link chatStream}). */
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
   * Compress a dialog by summarizing earlier turns into a system message.
   *
   * Keeps the last `keepLast` user/assistant messages verbatim and folds the
   * rest into a system note describing what the conversation was about.
   * Existing system messages are preserved and merged with the summary.
   *
   * @example
   * ```ts
   * const { messages } = await conductor.compressContext(history, { keepLast: 4 });
   * history.splice(0, history.length, ...messages);
   * ```
   */
  async compressContext(
    messages: Message[],
    options?: CompressContextOptions,
  ): Promise<CompressContextResult> {
    await this.ready;

    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('compressContext() requires a non-empty message array.');
    }

    const cloned = normalizeMessages(messages);

    const systemMessages = cloned.filter((message) => message.role === 'system');
    const conversation = cloned.filter((message) => message.role !== 'system');
    const keepLast = Math.max(0, options?.keepLast ?? DEFAULT_KEEP_LAST);

    if (conversation.length <= keepLast) {
      return {
        messages: cloned,
        summary: '',
        foldedCount: 0,
      };
    }

    const foldStart = 0;
    const foldEnd = conversation.length - keepLast;
    const toFold = conversation.slice(foldStart, foldEnd);
    const kept = conversation.slice(foldEnd);
    const transcript = toFold
      .map((message) => `${message.role}: ${messageText(message.content)}`)
      .join('\n');

    const summaryPrompt = options?.summaryPrompt?.trim() || DEFAULT_SUMMARY_PROMPT;
    const {
      provider: chatProvider,
      model,
      temperature,
      topP,
      maxTokens,
      frequencyPenalty,
      presencePenalty,
      stop,
      timeoutMs,
      metadata,
    } = options ?? {};

    const summaryResponse = await this.chat(
      [
        { role: 'system', content: summaryPrompt },
        {
          role: 'user',
          content: `Conversation to summarize:\n\n${transcript}`,
        },
      ],
      {
        provider: chatProvider,
        model,
        temperature: temperature ?? 0.2,
        topP,
        maxTokens: maxTokens ?? 512,
        frequencyPenalty,
        presencePenalty,
        stop,
        timeoutMs,
        metadata,
      },
    );

    const summary = summaryResponse.content.trim();
    if (!summary) {
      throw new Error('compressContext() received an empty summary from the provider.');
    }

    const systemParts = systemMessages
      .map((message) => messageText(message.content).trim())
      .filter(Boolean);
    systemParts.push(`Prior conversation context:\n${summary}`);

    return {
      messages: [{ role: 'system', content: systemParts.join('\n\n') }, ...kept],
      summary,
      foldedCount: toFold.length,
      provider: summaryResponse.provider,
      model: summaryResponse.model,
    };
  }

  /**
   * Chat with the configured providers using the active routing strategy.
   * @param input Plain string or message list.
   * @param options Per-request overrides.
   */
  async chat(input: string | Message[], options?: ChatOptions): Promise<ChatResponse> {
    await this.ready;
    const messages = normalizeMessages(input);
    const candidates = this.routeCandidates(options?.provider).map((config) => ({ config }));
    return this.executeChat(messages, options, candidates);
  }

  /**
   * Built-in vision support per provider: which providers accept images, known vision
   * models, and whether the configured model can see images.
   *
   * @param options.configuredOnly Only return providers enabled in the loaded config.
   */
  getVisionCapabilities(options?: { configuredOnly?: boolean }): VisionCapability[] {
    const config = this.getConfig();
    const result: VisionCapability[] = [];

    for (const meta of Object.values(PROVIDERS)) {
      const entry = config.providers.find((p) => p.id === meta.id && p.enabled !== false);
      if (options?.configuredOnly && !entry) continue;

      const model = entry ? this.toEndpoint(entry).model || undefined : meta.suggestedModels?.[0];
      const modelSupportsVision = model ? isLikelyVisionModel(meta.id, model) : undefined;
      result.push({
        provider: meta.id,
        label: meta.label,
        supportsVision: meta.supportsVision,
        visionModels: meta.visionModels?.slice() ?? [],
        configured: Boolean(entry),
        model,
        modelSupportsVision,
        recognitionModel: meta.supportsVision
          ? modelSupportsVision
            ? model
            : meta.visionModels?.[0]
          : undefined,
      });
    }

    return result;
  }

  /**
   * Whether a provider (and optionally a specific model) accepts image inputs.
   * Without `model`, answers for the provider in general.
   */
  supportsVision(providerId: string, model?: string): boolean {
    if (!isProviderId(providerId)) {
      throw new Error(
        `Unknown provider id "${providerId}". ${formatSuggestions(providerId, Object.keys(PROVIDERS))}`,
      );
    }
    if (model === undefined) return PROVIDERS[providerId].supportsVision;
    return isLikelyVisionModel(providerId, model);
  }

  /**
   * List models that accept image inputs for a configured provider (via `GET /models`;
   * uses catalog modalities when reported, otherwise name heuristics).
   */
  async listVisionModels(
    providerId: string,
    options?: { timeoutMs?: number },
  ): Promise<ListModelsResult>;
  /** List vision-capable models for every enabled configured provider that supports images. */
  async listVisionModels(options?: { timeoutMs?: number }): Promise<ListModelsResult[]>;
  async listVisionModels(
    providerIdOrOptions?: string | { timeoutMs?: number },
    options?: { timeoutMs?: number },
  ): Promise<ListModelsResult | ListModelsResult[]> {
    await this.ready;
    const onlyVision = (listed: ListModelsResult): ListModelsResult => ({
      ...listed,
      models: listed.models.filter((model) => model.supportsVision),
    });

    if (typeof providerIdOrOptions === 'string') {
      return onlyVision(await this.listModelsForProvider(providerIdOrOptions, options?.timeoutMs));
    }

    const timeoutMs = providerIdOrOptions?.timeoutMs ?? options?.timeoutMs;
    const results: ListModelsResult[] = [];
    for (const entry of this.config.providers) {
      if (entry.enabled === false || !PROVIDERS[entry.id].supportsVision) continue;
      results.push(onlyVision(await this.listModelsForProvider(entry.id, timeoutMs)));
    }
    return results;
  }

  /**
   * Recognize / describe one or more images with a vision-capable model.
   *
   * Routing follows the active strategy but only considers providers that accept images.
   * Per provider the model is: `options.model`, else the configured model when it supports
   * vision, else the first registry `visionModels` entry. Providers with no usable model are skipped.
   *
   * @param image Image (or images): URL, `data:` URL, local file path, or `{ data, mimeType }`.
   * @param options Prompt and chat overrides.
   *
   * @example
   * ```ts
   * const { content } = await conductor.recognizeImage('./receipt.jpg', {
   *   prompt: 'Extract the total amount.',
   * });
   * ```
   */
  async recognizeImage(
    image: ImageInput | ImageInput[],
    options?: RecognizeImageOptions,
  ): Promise<ChatResponse> {
    await this.ready;
    const images = Array.isArray(image) ? image : [image];
    if (images.length === 0) {
      throw new Error('recognizeImage() requires at least one image.');
    }

    const { prompt, systemPrompt, detail, ...chatOptions } = options ?? {};
    const parts: MessageContentPart[] = [
      { type: 'text', text: prompt?.trim() || DEFAULT_RECOGNIZE_PROMPT },
    ];
    for (const item of images) {
      parts.push(await toImageContentPart(item, detail));
    }

    const messages: Message[] = [];
    if (systemPrompt?.trim()) messages.push({ role: 'system', content: systemPrompt.trim() });
    messages.push({ role: 'user', content: parts });

    if (chatOptions.provider && isProviderId(chatOptions.provider)) {
      if (!PROVIDERS[chatOptions.provider].supportsVision) {
        throw new Error(`Provider "${chatOptions.provider}" does not support image inputs.`);
      }
    }

    const candidates: ChatCandidate[] = [];
    const skipped: string[] = [];
    for (const config of this.routeCandidates(chatOptions.provider)) {
      const meta = PROVIDERS[config.id];
      if (!meta.supportsVision) {
        skipped.push(`${config.id} (no vision)`);
        continue;
      }
      const configuredModel = this.toEndpoint(config).model;
      const model =
        chatOptions.model?.trim() ||
        (configuredModel && isLikelyVisionModel(config.id, configuredModel)
          ? configuredModel
          : meta.visionModels?.[0]);
      if (!model) {
        skipped.push(`${config.id} (no vision model; set one via options.model or config)`);
        continue;
      }
      candidates.push({ config, model });
    }

    if (candidates.length === 0) {
      throw new Error(
        `No vision-capable providers available.${skipped.length ? ` Skipped: ${skipped.join(', ')}.` : ''}`,
      );
    }

    return this.executeChat(messages, chatOptions, candidates);
  }

  /**
   * Stream a chat completion through the configured routing strategy.
   *
   * Returns immediately with a handle: await `result` for the final {@link ChatResponse},
   * or call `cancel()` to abort. Failover only happens **before** the first content chunk;
   * after tokens start arriving, the stream stays on that provider.
   *
   * @param input Plain string or message list.
   * @param onChunk Invoked for each piece of assistant text (see `chunkMode`).
   * @param options Per-request overrides (`chunkMode`: `delta` default, or `cumulative`).
   */
  chatStream(
    input: string | Message[],
    onChunk: ChatStreamChunkCallback,
    options?: ChatStreamOptions,
  ): ChatStreamHandle {
    const controller = new AbortController();
    const result = this.runChatStream(input, onChunk, options, controller.signal);
    return {
      result,
      cancel: () => controller.abort(),
    };
  }

  private async runChatStream(
    input: string | Message[],
    onChunk: ChatStreamChunkCallback,
    options: ChatStreamOptions | undefined,
    signal: AbortSignal,
  ): Promise<ChatResponse> {
    await this.ready;
    const messages = normalizeMessages(input);
    const strategy = this.getStrategy();
    const chunkMode = options?.chunkMode ?? 'delta';
    const ordered = this.routeCandidates(options?.provider);

    const failedProviders: string[] = [];
    let lastError: string | undefined;
    let accumulated = '';

    const deliverDelta = (delta: string) => {
      if (chunkMode === 'cumulative') {
        accumulated += delta;
        onChunk(accumulated);
      } else {
        onChunk(delta);
      }
    };

    for (const providerConfig of ordered) {
      if (signal.aborted) {
        throw new Error('Request cancelled');
      }

      const endpoint = this.toEndpoint(providerConfig);
      const streamResult = await openaiChatCompletionStream(
        endpoint,
        messages,
        deliverDelta,
        {
          ...options,
          model: options?.model ?? endpoint.model,
          timeoutMs: options?.timeoutMs ?? this.config.defaults?.timeoutMs,
          temperature: options?.temperature ?? this.config.defaults?.temperature,
          topP: options?.topP ?? this.config.defaults?.topP,
          maxTokens: options?.maxTokens ?? this.config.defaults?.maxTokens,
        },
        this.fetchImpl,
        signal,
      );

      if (streamResult.ok) {
        this.usage.record(providerConfig.id);
        return {
          content: streamResult.data.content,
          provider: providerConfig.id,
          model: streamResult.data.model,
          usage: streamResult.data.usage,
          strategy,
          failedProviders: failedProviders.length ? failedProviders : undefined,
          raw: streamResult.data.raw,
        };
      }

      // Tokens already went to the consumer — do not failover mid-stream.
      if (streamResult.emitted || signal.aborted) {
        throw new Error(streamResult.error.message);
      }

      failedProviders.push(providerConfig.id);
      lastError = streamResult.error.message;

      if (
        !streamResult.error.retryable &&
        !streamResult.error.rateLimited &&
        ordered.length === 1
      ) {
        break;
      }
    }

    throw new Error(
      `All providers failed (${failedProviders.join(' → ') || 'none'}). Last error: ${lastError ?? 'unknown'}`,
    );
  }

  /** Order enabled providers by the active strategy (or the forced one). */
  private routeCandidates(forcedId?: string): ProviderConfig[] {
    if (forcedId) {
      this.assertProviderOption(forcedId);
    }

    const { ordered, nextRoundRobinIndex } = orderProviders({
      providers: this.config.providers,
      strategy: this.getStrategy(),
      fallback: this.config.fallback,
      usage: this.usage,
      roundRobinIndex: this.roundRobinIndex,
      forcedId,
    });
    this.roundRobinIndex = nextRoundRobinIndex;

    if (ordered.length === 0) {
      throw new Error('No eligible providers (all disabled or daily limits reached).');
    }
    return ordered;
  }

  /** Try candidates in order until one returns a completion. */
  private async executeChat(
    messages: Message[],
    options: ChatOptions | undefined,
    candidates: ChatCandidate[],
  ): Promise<ChatResponse> {
    const strategy = this.getStrategy();
    const failedProviders: string[] = [];
    let lastError: string | undefined;

    for (const { config: providerConfig, model: candidateModel } of candidates) {
      const endpoint = this.toEndpoint(providerConfig);
      const result = await openaiChatCompletion(
        endpoint,
        messages,
        {
          ...options,
          model: candidateModel ?? options?.model ?? endpoint.model,
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
      if (!result.error.retryable && !result.error.rateLimited && candidates.length === 1) {
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
