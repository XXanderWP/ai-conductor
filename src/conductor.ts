import { loadConfigFile, mergeConfig, resolveApiKey } from './config/load.js';
import type {
  ConductorConfigUpdate,
  ConductorInitOptions,
  NormalizedConductorConfig,
  ProviderInstanceConfig,
} from './config/types.js';
import { ConductorError, type ConductorErrorAttempt, type ConductorErrorCode } from './errors.js';
import {
  endpointRequiresApiKey,
  openaiChatCompletion,
  openaiChatCompletionStream,
  openaiListModels,
  type OpenAIChatError,
  type OpenAIChatSuccess,
  type ResolvedProviderEndpoint,
} from './providers/openai-client.js';
import {
  isLikelyVisionModel,
  isProviderId,
  PROVIDERS,
  providerSupportsTools,
  type ProviderId,
  type ProviderMeta,
} from './providers/registry.js';
import { orderProviders } from './routing/order.js';
import { DailyUsageTracker } from './routing/usage.js';
import { stripThinkBlocks, ThinkStripper } from './think.js';
import type {
  ChatOptions,
  ChatResponse,
  ChatStreamChunkCallback,
  ChatStreamHandle,
  ChatStreamOptions,
  CompressContextOptions,
  CompressContextResult,
  ImageInput,
  ListModelsOptions,
  ListModelsResult,
  Message,
  MessageContentPart,
  ProviderTestOptions,
  ProviderTestResult,
  RecognizeImageOptions,
  RoutingStrategy,
  ToolCall,
  VisionCapability,
} from './types.js';
import {
  hasToolMessages,
  isToolCallMessage,
  isToolResultMessage,
  messageText,
  normalizeMessages,
} from './utils.js';
import { toImageContentPart } from './vision.js';
import { formatSuggestions } from './utils/suggest.js';

const DEFAULT_TEST_PROMPT = 'Reply with exactly: ok';
const DEFAULT_CONNECTIVITY_TIMEOUT_MS = 15_000;
const DEFAULT_KEEP_LAST = 4;
const DEFAULT_RECOGNIZE_PROMPT = 'Describe this image in detail.';
/** How many tool call ids are remembered for provider pinning. */
const MAX_TOOL_CALL_OWNERS = 1000;
/** Upper bound for the pause between internal retries. */
const MAX_RETRY_DELAY_MS = 30_000;

/** One routing candidate with an optional model override. */
interface ChatCandidate {
  config: ProviderInstanceConfig;
  model?: string;
}

/** Provider instance + model that issued a tool call. */
interface ToolCallOwner {
  provider: string;
  model?: string;
}

/** Config and keys a request started with (in-flight requests ignore later `updateConfig`). */
interface ConfigSnapshot {
  config: NormalizedConductorConfig;
  apiKeys: ConductorInitOptions['apiKeys'];
}

const DEFAULT_SUMMARY_PROMPT = [
  'Summarize the following conversation so it can replace the earlier turns.',
  'Capture the topic, key facts, decisions, open questions, and user preferences.',
  'Write in the same language as the conversation. Be concise but complete.',
  'Do not continue the dialogue. Reply with the summary only.',
].join(' ');

function configError(message: string, code: ConductorErrorCode = 'config'): ConductorError {
  return new ConductorError(message, { code });
}

/** Link an external signal to a controller; returns a function that removes the listener. */
function linkSignal(external: AbortSignal | undefined, controller: AbortController): () => void {
  if (!external) return () => undefined;
  if (external.aborted) {
    controller.abort();
    return () => undefined;
  }
  const onAbort = () => controller.abort();
  external.addEventListener('abort', onAbort, { once: true });
  return () => external.removeEventListener('abort', onAbort);
}

/** Sleep that ends early when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

function retryDelayMs(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec !== undefined) return Math.min(retryAfterSec * 1000, MAX_RETRY_DELAY_MS);
  return Math.min(500 * 2 ** attempt, 8_000);
}

function abortedError(attempts: ConductorErrorAttempt[]): ConductorError {
  return new ConductorError('Request cancelled', {
    code: 'aborted',
    status: 0,
    ...(attempts.length ? { attempts } : {}),
  });
}

function attemptOf(provider: string, error: ConductorError): ConductorErrorAttempt {
  return {
    provider,
    code: error.code,
    ...(error.status !== undefined ? { status: error.status } : {}),
    message: error.message,
  };
}

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
  private config!: NormalizedConductorConfig;
  private readonly init: ConductorInitOptions;
  private apiKeys: ConductorInitOptions['apiKeys'];
  private readonly usage: DailyUsageTracker;
  private readonly fetchImpl: typeof globalThis.fetch;
  private ready: Promise<void>;
  private roundRobinIndex = 0;
  private readonly toolCallOwners = new Map<string, ToolCallOwner>();

  constructor(options: ConductorInitOptions = {}) {
    this.init = options;
    this.apiKeys = options.apiKeys;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.usage = new DailyUsageTracker(options.now ?? (() => Date.now()), options.usageStore);
    this.ready = this.bootstrap();
  }

  /** Wait until config is loaded (also awaited automatically by {@link chat} / {@link chatStream}). */
  async whenReady(): Promise<void> {
    await this.ready;
  }

  /** Resolved configuration (after load/merge). Every entry has its type in `provider`. */
  getConfig(): NormalizedConductorConfig {
    if (!this.config) {
      throw configError('Conductor is not ready yet. Await whenReady() or chat().');
    }
    return this.config;
  }

  /** Active routing strategy. */
  getStrategy(): RoutingStrategy {
    return this.getConfig().routing?.strategy ?? 'cheapest';
  }

  /** Soft daily usage count for a provider instance (UTC day). */
  getDailyUsage(providerId: string): number {
    return this.usage.getCount(providerId);
  }

  /**
   * Replace providers / routing / fallback / defaults / apiKeys without a new instance.
   * Usage counters and the round-robin position are kept for instance ids that still exist;
   * state of removed ids is dropped. In-flight requests finish with the config they started with.
   */
  async updateConfig(update: ConductorConfigUpdate): Promise<void> {
    await this.ready;
    const prev = this.config;
    const providers = update.providers
      ? mergeConfig(undefined, { providers: update.providers, env: this.init.env }).providers
      : prev.providers;

    const next: NormalizedConductorConfig = {
      providers,
      routing: { strategy: update.routing?.strategy ?? prev.routing?.strategy ?? 'cheapest' },
      fallback: update.fallback ?? prev.fallback,
      defaults: update.defaults ?? prev.defaults,
    };

    const ids = new Set(providers.map((p) => p.id));
    const removed = prev.providers.map((p) => p.id).filter((id) => !ids.has(id));
    this.usage.forget(removed);
    for (const [callId, owner] of this.toolCallOwners) {
      if (!ids.has(owner.provider)) this.toolCallOwners.delete(callId);
    }
    if (update.apiKeys) this.apiKeys = update.apiKeys;
    this.config = next;
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
  getConfiguredProviders(): ProviderInstanceConfig[] {
    return this.getConfig().providers.slice();
  }

  /**
   * Fetch and parse available models for a configured provider instance via `GET /models`
   * (with Puter / Ollama fallbacks where needed).
   */
  async listModels(providerId: string, options?: ListModelsOptions): Promise<ListModelsResult>;
  /**
   * Fetch and parse available models for every enabled configured provider.
   */
  async listModels(options?: ListModelsOptions): Promise<ListModelsResult[]>;
  async listModels(
    providerIdOrOptions?: string | ListModelsOptions,
    options?: ListModelsOptions,
  ): Promise<ListModelsResult | ListModelsResult[]> {
    await this.ready;
    const snap = this.snapshot();

    if (typeof providerIdOrOptions === 'string') {
      return this.listModelsForProvider(snap, providerIdOrOptions, options);
    }

    const opts = providerIdOrOptions ?? options;
    const results: ListModelsResult[] = [];
    for (const entry of snap.config.providers) {
      if (entry.enabled === false) continue;
      results.push(await this.listModelsForProvider(snap, entry.id, opts));
    }
    return results;
  }

  /**
   * Probe a configured provider instance.
   *
   * - `real: false` / omitted — check API key presence and the models catalog.
   * - `real: true` — send a short chat completion and require non-empty content.
   */
  async testProvider(
    providerId: string,
    options?: ProviderTestOptions,
  ): Promise<ProviderTestResult> {
    await this.ready;
    const snap = this.snapshot();
    this.assertProviderOption(snap, providerId);

    const started = Date.now();
    const providerConfig = this.findInstance(snap, providerId)!;
    const endpoint = this.toEndpoint(snap, providerConfig);
    const apiKeyPresent = !endpointRequiresApiKey(endpoint) || Boolean(endpoint.apiKey);

    if (options?.real) {
      return this.runRealProviderTest(snap, providerConfig, endpoint, started, {
        prompt: options.prompt,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        apiKeyPresent,
      });
    }

    return this.runConnectivityProviderTest(providerId, endpoint, started, {
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
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
      throw configError('compressContext() requires a non-empty message array.');
    }

    const cloned = normalizeMessages(messages);

    const systemMessages = cloned.filter((message) => message.role === 'system');
    const conversation = cloned.filter((message) => message.role !== 'system');
    const keepLast = Math.max(0, options?.keepLast ?? DEFAULT_KEEP_LAST);

    const foldEnd = hasToolMessages(conversation)
      ? toolSafeCutIndex(conversation, conversation.length - keepLast)
      : conversation.length - keepLast;

    if (foldEnd <= 0) {
      return {
        messages: cloned,
        summary: '',
        foldedCount: 0,
      };
    }

    const toFold = conversation.slice(0, foldEnd);
    const kept = dropOrphanToolResults(conversation.slice(foldEnd));
    const transcript = toFold
      .map((message) => `${message.role}: ${messageText(message)}`)
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
      extraBody,
      headers,
      signal,
      fallback,
      retries,
      reasoningEffort,
      stripThinking,
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
        extraBody,
        headers,
        signal,
        fallback,
        retries,
        reasoningEffort,
        stripThinking,
      },
    );

    const summary = summaryResponse.content.trim();
    if (!summary) {
      throw new ConductorError('compressContext() received an empty summary from the provider.', {
        code: 'http',
        provider: summaryResponse.provider,
        providerType: summaryResponse.providerType,
        model: summaryResponse.model,
      });
    }

    const systemParts = systemMessages
      .map((message) => messageText(message).trim())
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
   * Rejects with {@link ConductorError}.
   * @param input Plain string or message list.
   * @param options Per-request overrides.
   */
  async chat(input: string | Message[], options?: ChatOptions): Promise<ChatResponse> {
    await this.ready;
    const snap = this.snapshot();
    const messages = normalizeMessages(input);
    return this.executeChat(snap, messages, options, this.chatCandidates(snap, messages, options));
  }

  /**
   * Built-in vision support per provider: which providers accept images, known vision
   * models, and whether the configured model can see images.
   *
   * @param options.configuredOnly Only return providers enabled in the loaded config.
   */
  getVisionCapabilities(options?: { configuredOnly?: boolean }): VisionCapability[] {
    const config = this.getConfig();
    const snap = this.snapshot();
    const result: VisionCapability[] = [];

    for (const meta of Object.values(PROVIDERS)) {
      const entry = config.providers.find((p) => p.provider === meta.id && p.enabled !== false);
      if (options?.configuredOnly && !entry) continue;

      const model = entry
        ? this.toEndpoint(snap, entry).model || undefined
        : meta.suggestedModels?.[0];
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
   * Whether a provider (built-in id or configured instance id, optionally with a model)
   * accepts image inputs. Without `model`, answers for the provider in general.
   */
  supportsVision(providerId: string, model?: string): boolean {
    const type = this.config ? this.findInstance(this.snapshot(), providerId)?.provider : undefined;
    const resolved = type ?? (isProviderId(providerId) ? providerId : undefined);
    if (!resolved) {
      throw configError(
        `Unknown provider id "${providerId}". ${formatSuggestions(providerId, Object.keys(PROVIDERS))}`,
      );
    }
    if (model === undefined) return PROVIDERS[resolved].supportsVision;
    return isLikelyVisionModel(resolved, model);
  }

  /**
   * List models that accept image inputs for a configured provider (via `GET /models`;
   * uses catalog modalities when reported, otherwise name heuristics).
   */
  async listVisionModels(
    providerId: string,
    options?: ListModelsOptions,
  ): Promise<ListModelsResult>;
  /** List vision-capable models for every enabled configured provider that supports images. */
  async listVisionModels(options?: ListModelsOptions): Promise<ListModelsResult[]>;
  async listVisionModels(
    providerIdOrOptions?: string | ListModelsOptions,
    options?: ListModelsOptions,
  ): Promise<ListModelsResult | ListModelsResult[]> {
    await this.ready;
    const snap = this.snapshot();
    const onlyVision = (listed: ListModelsResult): ListModelsResult => ({
      ...listed,
      models: listed.models.filter((model) => model.supportsVision),
    });

    if (typeof providerIdOrOptions === 'string') {
      return onlyVision(await this.listModelsForProvider(snap, providerIdOrOptions, options));
    }

    const opts = providerIdOrOptions ?? options;
    const results: ListModelsResult[] = [];
    for (const entry of snap.config.providers) {
      if (entry.enabled === false || !PROVIDERS[entry.provider].supportsVision) continue;
      results.push(onlyVision(await this.listModelsForProvider(snap, entry.id, opts)));
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
    const snap = this.snapshot();
    const images = Array.isArray(image) ? image : [image];
    if (images.length === 0) {
      throw configError('recognizeImage() requires at least one image.');
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

    if (chatOptions.provider) {
      const forced = this.findInstance(snap, chatOptions.provider);
      const type =
        forced?.provider ?? (isProviderId(chatOptions.provider) ? chatOptions.provider : undefined);
      if (type && !PROVIDERS[type].supportsVision) {
        throw configError(`Provider "${chatOptions.provider}" does not support image inputs.`);
      }
    }

    const routed = this.routeCandidates(snap, chatOptions.provider);
    const candidates: ChatCandidate[] = [];
    const skipped: string[] = [];
    for (const config of chatOptions.fallback === false ? routed.slice(0, 1) : routed) {
      const meta = PROVIDERS[config.provider];
      if (!meta.supportsVision) {
        skipped.push(`${config.id} (no vision)`);
        continue;
      }
      if (chatOptions.tools?.length && !this.supportsToolsFor(config)) {
        skipped.push(`${config.id} (no tools)`);
        continue;
      }
      const configuredModel = this.toEndpoint(snap, config).model;
      const model =
        chatOptions.model?.trim() ||
        (configuredModel && isLikelyVisionModel(config.provider, configuredModel)
          ? configuredModel
          : meta.visionModels?.[0]);
      if (!model) {
        skipped.push(`${config.id} (no vision model; set one via options.model or config)`);
        continue;
      }
      candidates.push({ config, model });
    }

    if (candidates.length === 0) {
      throw configError(
        `No vision-capable providers available.${skipped.length ? ` Skipped: ${skipped.join(', ')}.` : ''}`,
        'no_provider',
      );
    }

    return this.executeChat(snap, messages, chatOptions, candidates);
  }

  /**
   * Stream a chat completion through the configured routing strategy.
   *
   * Returns immediately with a handle: await `result` for the final {@link ChatResponse},
   * or call `cancel()` (or abort `options.signal`) to stop. Failover only happens **before**
   * the first content chunk; after tokens start arriving, the stream stays on that provider.
   * `result` rejects with {@link ConductorError} (`aborted`, `stalled`, …).
   *
   * Tool call fragments are assembled internally (never sent to `onChunk`); finished calls
   * are reported via `options.onToolCall` and `result.toolCalls`.
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
    const detach = linkSignal(options?.signal, controller);
    const result = this.runChatStream(input, onChunk, options, controller.signal);
    result.then(detach, detach);
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
    const snap = this.snapshot();
    const messages = normalizeMessages(input);
    const strategy = snap.config.routing?.strategy ?? 'cheapest';
    const chunkMode = options?.chunkMode ?? 'delta';
    const ordered = this.chatCandidates(snap, messages, options);
    const retries = Math.max(0, Math.floor(options?.retries ?? 0));
    const attempts: ConductorErrorAttempt[] = [];
    const failedProviders: string[] = [];
    let lastError: ConductorError | undefined;

    const onActivity = options?.onActivity;
    const hooks = {
      idleTimeoutMs: options?.idleTimeoutMs,
      totalTimeoutMs: options?.totalTimeoutMs,
      onReasoning: options?.onReasoning,
      // `text` is reported after `<think>` stripping (see deliver below).
      onActivity: onActivity
        ? (kind: 'reasoning' | 'text' | 'tool') => {
            if (kind !== 'text') onActivity(kind);
          }
        : undefined,
    };

    for (const { config: providerConfig, model: candidateModel } of ordered) {
      const endpoint = this.toEndpoint(snap, providerConfig);
      const requestModel = candidateModel ?? options?.model ?? endpoint.model;

      for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (signal.aborted) throw abortedError(attempts);

        let accumulated = '';
        const stripper = options?.stripThinking
          ? new ThinkStripper((text) => {
              options.onReasoning?.(text);
              onActivity?.('reasoning');
            })
          : undefined;
        const deliver = (delta: string) => {
          const visible = stripper ? stripper.push(delta) : delta;
          if (!visible) return;
          onActivity?.('text');
          if (chunkMode === 'cumulative') {
            accumulated += visible;
            onChunk(accumulated);
          } else {
            onChunk(visible);
          }
        };

        const started = Date.now();
        const streamResult = await openaiChatCompletionStream(
          endpoint,
          messages,
          deliver,
          this.requestOptions(snap, options, requestModel),
          this.fetchImpl,
          signal,
          hooks,
        );
        this.report(providerConfig, requestModel, started, streamResult);

        if (streamResult.ok) {
          const tail = stripper?.flush();
          if (tail) {
            onActivity?.('text');
            accumulated += tail;
            onChunk(chunkMode === 'cumulative' ? accumulated : tail);
          }
          const data = streamResult.data;
          this.usage.record(providerConfig.id);
          this.rememberToolCalls(data.toolCalls, providerConfig.id, requestModel);
          for (const call of data.toolCalls ?? []) options?.onToolCall?.(call);
          return this.buildResponse(providerConfig, data, strategy, failedProviders, options);
        }

        const partial = streamResult.error.partialContent;
        const error = this.toConductorError(providerConfig, requestModel, {
          ...streamResult.error,
          ...(partial && options?.stripThinking
            ? { partialContent: stripThinkBlocks(partial).text }
            : {}),
        });
        attempts.push(attemptOf(providerConfig.id, error));

        if (streamResult.error.code === 'aborted' || signal.aborted) throw abortedError(attempts);
        // Tokens already went to the consumer — do not retry or fail over mid-stream.
        if (streamResult.emitted) throw this.withAttempts(error, attempts);

        lastError = error;
        if (!streamResult.error.retryable || attempt === retries) break;
        await sleep(retryDelayMs(attempt, error.retryAfterSec), signal);
      }

      failedProviders.push(providerConfig.id);
    }

    throw this.chainError(lastError, failedProviders, attempts, options);
  }

  /** Order enabled providers by the active strategy (or the forced one). */
  private routeCandidates(snap: ConfigSnapshot, forcedId?: string): ProviderInstanceConfig[] {
    if (forcedId) {
      this.assertProviderOption(snap, forcedId);
    }

    const { ordered, nextRoundRobinIndex } = orderProviders({
      providers: snap.config.providers,
      strategy: snap.config.routing?.strategy ?? 'cheapest',
      fallback: snap.config.fallback,
      usage: this.usage,
      roundRobinIndex: this.roundRobinIndex,
      forcedId,
    });
    this.roundRobinIndex = nextRoundRobinIndex;

    if (ordered.length === 0) {
      throw configError(
        'No eligible providers (all disabled or daily limits reached).',
        'no_provider',
      );
    }
    return ordered;
  }

  /**
   * Routing candidates for a chat request:
   * - `fallback: false` → exactly one candidate (the forced instance or the first routed one);
   * - with `tools`, skip providers whose `supportsTools` is `false`;
   * - history with tool calls / results is pinned to one provider (the one that issued the
   *   calls when known, else `options.provider` or the first routed provider) unless
   *   `allowToolFailover` is set.
   */
  private chatCandidates(
    snap: ConfigSnapshot,
    messages: Message[],
    options: ChatOptions | undefined,
  ): ChatCandidate[] {
    const wantsTools = Boolean(options?.tools?.length);
    const toolPinned = hasToolMessages(messages) && !options?.allowToolFailover;
    const single = toolPinned || options?.fallback === false;
    const owner = options?.provider ? undefined : this.toolCallOwner(snap, messages);

    let ordered = this.routeCandidates(
      snap,
      options?.provider ?? (toolPinned ? owner?.provider : undefined),
    );
    if (owner && !toolPinned) {
      ordered = [
        ...ordered.filter((c) => c.id === owner.provider),
        ...ordered.filter((c) => c.id !== owner.provider),
      ];
    }

    if (wantsTools) {
      const skipped = ordered.filter((c) => !this.supportsToolsFor(c)).map((c) => c.id);
      ordered = ordered.filter((c) => this.supportsToolsFor(c));
      if (ordered.length === 0) {
        throw configError(
          options?.provider
            ? `Provider "${options.provider}" does not support tools.`
            : `No tool-capable providers available.${skipped.length ? ` Skipped: ${skipped.join(', ')}.` : ''}`,
          'no_provider',
        );
      }
    }

    if (single) ordered = ordered.slice(0, 1);

    return ordered.map((config) => ({
      config,
      model:
        owner && config.id === owner.provider && !options?.model?.trim() ? owner.model : undefined,
    }));
  }

  /** Whether a configured provider/model accepts `tools` (config overrides the registry). */
  private supportsToolsFor(config: ProviderInstanceConfig): boolean {
    return config.supportsTools ?? providerSupportsTools(config.provider);
  }

  /** Provider instance that issued the most recent known tool call in the history. */
  private toolCallOwner(snap: ConfigSnapshot, messages: Message[]): ToolCallOwner | undefined {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]!;
      const ids = isToolCallMessage(message)
        ? message.tool_calls.map((call) => call.id)
        : isToolResultMessage(message)
          ? [message.tool_call_id]
          : [];
      for (const id of ids) {
        const owner = this.toolCallOwners.get(id);
        if (owner && snap.config.providers.some((p) => p.id === owner.provider)) return owner;
      }
    }
    return undefined;
  }

  private rememberToolCalls(
    toolCalls: ToolCall[] | undefined,
    provider: string,
    model: string | undefined,
  ): void {
    for (const call of toolCalls ?? []) {
      this.toolCallOwners.delete(call.id);
      this.toolCallOwners.set(call.id, { provider, model: model || undefined });
    }
    while (this.toolCallOwners.size > MAX_TOOL_CALL_OWNERS) {
      const oldest = this.toolCallOwners.keys().next().value;
      if (oldest === undefined) break;
      this.toolCallOwners.delete(oldest);
    }
  }

  /** Per-attempt client options (config defaults applied). */
  private requestOptions(
    snap: ConfigSnapshot,
    options: ChatOptions | undefined,
    model: string,
  ): ChatOptions {
    const defaults = snap.config.defaults;
    return {
      ...options,
      model,
      timeoutMs: options?.timeoutMs ?? defaults?.timeoutMs,
      temperature: options?.temperature ?? defaults?.temperature,
      topP: options?.topP ?? defaults?.topP,
      maxTokens: options?.maxTokens ?? defaults?.maxTokens,
    };
  }

  /** Try candidates in order until one returns a completion. */
  private async executeChat(
    snap: ConfigSnapshot,
    messages: Message[],
    options: ChatOptions | undefined,
    candidates: ChatCandidate[],
  ): Promise<ChatResponse> {
    const strategy = snap.config.routing?.strategy ?? 'cheapest';
    const retries = Math.max(0, Math.floor(options?.retries ?? 0));
    const failedProviders: string[] = [];
    const attempts: ConductorErrorAttempt[] = [];
    let lastError: ConductorError | undefined;
    const controller = new AbortController();
    const detach = linkSignal(options?.signal, controller);
    const signal = controller.signal;

    try {
      for (const { config: providerConfig, model: candidateModel } of candidates) {
        const endpoint = this.toEndpoint(snap, providerConfig);
        const requestModel = candidateModel ?? options?.model ?? endpoint.model;

        for (let attempt = 0; attempt <= retries; attempt += 1) {
          if (signal.aborted) throw abortedError(attempts);

          const started = Date.now();
          const result = await openaiChatCompletion(
            endpoint,
            messages,
            this.requestOptions(snap, options, requestModel),
            this.fetchImpl,
            signal,
          );
          this.report(providerConfig, requestModel, started, result);

          if (result.ok) {
            this.usage.record(providerConfig.id);
            this.rememberToolCalls(result.data.toolCalls, providerConfig.id, requestModel);
            return this.buildResponse(
              providerConfig,
              result.data,
              strategy,
              failedProviders,
              options,
            );
          }

          const error = this.toConductorError(providerConfig, requestModel, result.error);
          attempts.push(attemptOf(providerConfig.id, error));
          if (result.error.code === 'aborted' || signal.aborted) throw abortedError(attempts);

          lastError = error;
          if (!result.error.retryable || attempt === retries) break;
          await sleep(retryDelayMs(attempt, error.retryAfterSec), signal);
        }

        failedProviders.push(providerConfig.id);
      }
    } finally {
      detach();
    }

    throw this.chainError(lastError, failedProviders, attempts, options);
  }

  private buildResponse(
    config: ProviderInstanceConfig,
    data: OpenAIChatSuccess,
    strategy: RoutingStrategy,
    failedProviders: string[],
    options: ChatOptions | undefined,
  ): ChatResponse {
    let content = data.content;
    let reasoning = data.reasoning;
    if (options?.stripThinking) {
      const stripped = stripThinkBlocks(content);
      content = stripped.text;
      if (stripped.thinking) {
        reasoning = reasoning ? `${reasoning}\n${stripped.thinking}` : stripped.thinking;
      }
    }
    const { toolCalls, finishReason } = data;
    return {
      content,
      provider: config.id,
      providerType: config.provider,
      model: data.model,
      usage: data.usage,
      strategy,
      failedProviders: failedProviders.length ? failedProviders : undefined,
      raw: data.raw,
      ...(toolCalls ? { toolCalls } : {}),
      ...(finishReason ? { finishReason } : {}),
      headers: data.headers,
      ...(reasoning ? { reasoning } : {}),
    };
  }

  private toConductorError(
    config: ProviderInstanceConfig,
    model: string | undefined,
    error: OpenAIChatError,
  ): ConductorError {
    return new ConductorError(error.message, {
      code: error.code,
      status: error.status,
      provider: config.id,
      providerType: config.provider,
      model: model || undefined,
      retryAfterSec: error.retryAfterSec,
      headers: error.headers,
      body: error.body,
      partialContent: error.partialContent,
    });
  }

  private withAttempts(error: ConductorError, attempts: ConductorErrorAttempt[]): ConductorError {
    return new ConductorError(error.message, { ...error, attempts: [...attempts] });
  }

  /** Final error after every candidate failed. */
  private chainError(
    last: ConductorError | undefined,
    failedProviders: string[],
    attempts: ConductorErrorAttempt[],
    options: ChatOptions | undefined,
  ): ConductorError {
    const lastMessage = last?.message ?? 'unknown';
    const message =
      options?.fallback === false && last
        ? lastMessage
        : `All providers failed (${failedProviders.join(' → ') || 'none'}). Last error: ${lastMessage}`;
    return new ConductorError(message, {
      ...last,
      code: last?.code ?? 'no_provider',
      attempts: [...attempts],
    });
  }

  /** Call `onResponse` for one HTTP attempt (callback errors are ignored). */
  private report(
    config: ProviderInstanceConfig,
    model: string,
    started: number,
    result: { ok: true; data: OpenAIChatSuccess } | { ok: false; error: OpenAIChatError },
  ): void {
    const onResponse = this.init.onResponse;
    if (!onResponse) return;
    const durationMs = Date.now() - started;
    try {
      if (result.ok) {
        onResponse({
          provider: config.id,
          providerType: config.provider,
          model: result.data.model ?? model,
          status: result.data.status,
          ok: true,
          headers: result.data.headers,
          usage: result.data.usage,
          durationMs,
        });
      } else {
        onResponse({
          provider: config.id,
          providerType: config.provider,
          model,
          status: result.error.status,
          ok: false,
          headers: result.error.headers,
          durationMs,
          error: this.toConductorError(config, model, result.error),
        });
      }
    } catch {
      // Host callback errors must not break the request.
    }
  }

  private snapshot(): ConfigSnapshot {
    return { config: this.config, apiKeys: this.apiKeys };
  }

  private findInstance(snap: ConfigSnapshot, id: string): ProviderInstanceConfig | undefined {
    return snap.config.providers.find((p) => p.id === id);
  }

  private async bootstrap(): Promise<void> {
    let fileConfig: NormalizedConductorConfig | undefined;
    if (this.init.configPath) {
      fileConfig = await loadConfigFile(this.init.configPath, { env: this.init.env });
    }
    this.config = mergeConfig(fileConfig, this.init);
  }

  private async listModelsForProvider(
    snap: ConfigSnapshot,
    providerId: string,
    options?: ListModelsOptions,
  ): Promise<ListModelsResult> {
    this.assertProviderConfigured(snap, providerId);
    const providerConfig = this.findInstance(snap, providerId)!;
    const endpoint = this.toEndpoint(snap, providerConfig);
    const listed = await openaiListModels(
      endpoint,
      options?.timeoutMs ?? DEFAULT_CONNECTIVITY_TIMEOUT_MS,
      this.fetchImpl,
      { signal: options?.signal, details: options?.details },
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
    options: { timeoutMs?: number; signal?: AbortSignal; apiKeyPresent: boolean },
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
      { signal: options.signal },
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
    snap: ConfigSnapshot,
    config: ProviderInstanceConfig,
    endpoint: ResolvedProviderEndpoint,
    started: number,
    options: {
      prompt?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      apiKeyPresent: boolean;
    },
  ): Promise<ProviderTestResult> {
    const providerId = config.id;
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
    const attemptStarted = Date.now();
    const result = await openaiChatCompletion(
      endpoint,
      [{ role: 'user', content: prompt }],
      {
        model: endpoint.model,
        timeoutMs: options.timeoutMs ?? snap.config.defaults?.timeoutMs,
        maxTokens: 16,
        temperature: 0,
      },
      this.fetchImpl,
      options.signal,
    );
    this.report(config, endpoint.model, attemptStarted, result);

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

  private assertProviderConfigured(snap: ConfigSnapshot, providerId: string): void {
    const configuredIds = snap.config.providers.map((p) => p.id);
    if (configuredIds.includes(providerId)) return;

    if (!isProviderId(providerId)) {
      const candidates = [...new Set([...configuredIds, ...Object.keys(PROVIDERS)])];
      throw configError(
        `Unknown provider id "${providerId}". ${formatSuggestions(providerId, candidates)}`,
      );
    }

    throw configError(
      `Provider "${providerId}" is not in the current config. ${formatSuggestions(providerId, configuredIds)}`,
    );
  }

  private assertProviderOption(snap: ConfigSnapshot, providerId: string): void {
    this.assertProviderConfigured(snap, providerId);

    const entry = this.findInstance(snap, providerId)!;
    if (entry.enabled === false) {
      throw configError(`Provider "${providerId}" is disabled in the config.`);
    }

    if (this.usage.isExhausted(providerId, entry.dailyLimit)) {
      throw new ConductorError(
        `Provider "${providerId}" reached its dailyLimit (${entry.dailyLimit}).`,
        { code: 'daily_limit', provider: entry.id, providerType: entry.provider },
      );
    }
  }

  private toEndpoint(
    snap: ConfigSnapshot,
    providerConfig: ProviderInstanceConfig,
  ): ResolvedProviderEndpoint {
    const meta = PROVIDERS[providerConfig.provider];
    const apiKey = resolveApiKey(providerConfig.provider, providerConfig.apiKey, snap.apiKeys, {
      env: this.init.env,
      instanceId: providerConfig.id,
    });
    const model =
      providerConfig.model?.trim() ||
      snap.config.defaults?.model?.trim() ||
      meta.suggestedModels?.[0] ||
      '';

    return {
      id: providerConfig.provider,
      instanceId: providerConfig.id,
      model,
      apiKey,
      baseUrl: providerConfig.baseUrl ?? meta.defaultBaseUrl,
      params: {
        ...snap.config.defaults,
        ...providerConfig.params,
      },
      headers: providerConfig.headers,
      supportsReasoningEffort: providerConfig.supportsReasoningEffort,
      supportsStreamUsage: providerConfig.supportsStreamUsage,
    };
  }
}

/**
 * Move a fold cut point onto a `user` message boundary so tool call / result pairs stay
 * together: first backwards (keep more), then forwards. Returns `0` when no safe cut exists.
 */
function toolSafeCutIndex(conversation: Message[], target: number): number {
  if (target <= 0) return 0;
  if (target >= conversation.length) return conversation.length;
  for (let i = target; i > 0; i -= 1) {
    if (conversation[i]!.role === 'user') return i;
  }
  for (let i = target + 1; i < conversation.length; i += 1) {
    if (conversation[i]!.role === 'user') return i;
  }
  return 0;
}

/** Drop tool results whose `tool_call_id` has no matching earlier call (providers return 400). */
function dropOrphanToolResults(messages: Message[]): Message[] {
  const known = new Set<string>();
  return messages.filter((message) => {
    if (isToolCallMessage(message)) {
      for (const call of message.tool_calls) known.add(call.id);
      return true;
    }
    return !isToolResultMessage(message) || known.has(message.tool_call_id);
  });
}

/** @deprecated Use {@link Conductor}. Kept for early 0.1 compatibility. */
export { Conductor as AIConductor };

export type { ProviderId };
