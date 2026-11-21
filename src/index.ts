/**
 * AI Conductor — orchestrate any AI provider through one API.
 *
 * @packageDocumentation
 */

export { Conductor, AIConductor } from './conductor.js';
export { ConductorError, isConductorError, classifyHttpError } from './errors.js';
export type { ConductorErrorCode, ConductorErrorAttempt, ConductorErrorInit } from './errors.js';
export { parseRateLimitHeaders, parseDurationMs } from './ratelimit.js';
export type { RateLimitInfo } from './ratelimit.js';
export { stripThinkBlocks } from './think.js';
export { MemoryUsageStore } from './routing/usage.js';
export {
  PROVIDERS,
  PROVIDER_AUTO_ORDER,
  isProviderId,
  isLikelyFreeModel,
  resolveBaseUrl,
  getFixedTemperature,
  isLikelyVisionModel,
  providerSupportsTools,
} from './providers/registry.js';
export type { ProviderId, ProviderMeta, RateLimitHint } from './providers/registry.js';
export {
  loadConfigFile,
  normalizeConfig,
  mergeConfig,
  resolveApiKey,
  interpolateEnv,
} from './config/load.js';
export type { ConfigEnvOptions, ResolveApiKeyOptions } from './config/load.js';
export type {
  ConductorConfig,
  ConductorConfigUpdate,
  ConductorInitOptions,
  ConductorResponseEvent,
  NormalizedConductorConfig,
  ProviderConfig,
  ProviderInstanceConfig,
  AnyProviderConfig,
  EnvSource,
  UsageState,
  UsageStore,
  RoutingConfig,
} from './config/types.js';
export {
  normalizeMessages,
  toPrompt,
  messageText,
  isToolCallMessage,
  isToolResultMessage,
  toolResultMessage,
  assistantMessageFromResponse,
} from './utils.js';
export { toImageContentPart, imageMimeTypeFromPath } from './vision.js';
export { suggestClosest, formatSuggestions } from './utils/suggest.js';
export type {
  Message,
  TextMessage,
  AssistantToolCallMessage,
  ToolResultMessage,
  ToolDefinition,
  ToolChoice,
  ToolCall,
  JsonSchema,
  MessageRole,
  MessageContentPart,
  TextContentPart,
  ImageContentPart,
  ImageDetail,
  ImageInput,
  RecognizeImageOptions,
  VisionCapability,
  ChatOptions,
  ChatResponse,
  ChatStreamOptions,
  ChatStreamHandle,
  ChatStreamChunkCallback,
  StreamChunkMode,
  RoutingStrategy,
  GenerationParams,
  TokenUsage,
  ModelInfo,
  ListModelsOptions,
  ListModelsResult,
  ReasoningEffort,
  ProviderTestOptions,
  ProviderTestResult,
  CompressContextOptions,
  CompressContextResult,
} from './types.js';
export type {
  OpenAIModelInfo,
  OpenAIListModelsResult,
  OpenAIListModelsOptions,
  DetectOllamaResult,
} from './providers/openai-client.js';
export {
  openaiListModels,
  normalizeProviderModelId,
  detectOllama,
} from './providers/openai-client.js';
