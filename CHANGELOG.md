# Changelog

## 0.3.0

### Added

- Multiple instances of one provider type: `ProviderConfig.provider` makes `id` a free-form instance id; `ChatResponse.providerType`.
- Transport mode: `ChatOptions.fallback: false`, `retries`; `daily_limit` error for the requested instance.
- `ConductorError` / `isConductorError` with `code`, `status`, `provider`, `providerType`, `model`, `retryAfterSec`, `headers`, `body`, `partialContent`, `attempts`.
- `ChatResponse.headers`; streaming usage via `stream_options.include_usage` (registry `supportsStreamUsage`).
- `ChatOptions.signal` (chat, streams, listModels, testProvider, compressContext, recognizeImage).
- Stream watchdogs: `idleTimeoutMs`, `totalTimeoutMs` (`stalled`); `timeoutMs` now bounds the wait for stream headers.
- `ConductorInitOptions.env` (`false` disables env key lookup and `${VAR}` expansion).
- Reasoning: `onReasoning`, `onActivity`, `stripThinking`, `ChatResponse.reasoning`.
- `ProviderConfig.headers`, `ChatOptions.headers`, `ChatOptions.extraBody`; anonymous `openai_compatible` gateways (no empty `Authorization`).
- `ChatOptions.reasoningEffort` (registry `supportsReasoningEffort`: Gemini, OpenAI, Groq).
- `onResponse` hook, pluggable `usageStore`, `parseRateLimitHeaders`.
- `conductor.updateConfig()`.
- `ModelInfo.contextLength` / `supportsTools` / `isFree` / `raw` (`listModels(id, { details: true })`), `detectOllama()`.

No breaking changes. Note: `ConductorConfig.providers` is now `AnyProviderConfig[]` and `getConfiguredProviders()` returns entries with `provider` set, so reading `.id` from them is typed as `string`.

## 0.2.0

### Added

- OpenAI-compatible tool calling (`tools`, `tool_choice`, `tool_calls`, `tool` role), streaming tool call assembly, Gemini `thought_signature` passthrough, array error bodies.

No breaking changes.
