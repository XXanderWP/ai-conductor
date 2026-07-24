/**
 * AI Conductor — orchestrate any AI provider through one API.
 *
 * @packageDocumentation
 */

export { Conductor, AIConductor } from './conductor.js';
export {
  PROVIDERS,
  PROVIDER_AUTO_ORDER,
  isProviderId,
  isLikelyFreeModel,
  resolveBaseUrl,
  getFixedTemperature,
} from './providers/registry.js';
export type { ProviderId, ProviderMeta, RateLimitHint } from './providers/registry.js';
export { loadConfigFile, normalizeConfig, mergeConfig, resolveApiKey } from './config/load.js';
export type {
  ConductorConfig,
  ConductorInitOptions,
  ProviderConfig,
  RoutingConfig,
} from './config/types.js';
export { normalizeMessages, toPrompt } from './utils.js';
export { suggestClosest, formatSuggestions } from './utils/suggest.js';
export type {
  Message,
  MessageRole,
  ChatOptions,
  ChatResponse,
  RoutingStrategy,
  GenerationParams,
  TokenUsage,
  ModelInfo,
  ListModelsResult,
  ProviderTestOptions,
  ProviderTestResult,
  CompressContextOptions,
  CompressContextResult,
} from './types.js';
export type { OpenAIModelInfo, OpenAIListModelsResult } from './providers/openai-client.js';
export { openaiListModels, normalizeProviderModelId } from './providers/openai-client.js';
