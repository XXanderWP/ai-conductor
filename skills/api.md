# Skill: Public API & providers

## Purpose

Guide agents implementing or extending the AI Conductor public API and provider adapters.

## Core API

- `Conductor` — main orchestrator (`new Conductor({ configPath })` or inline options)
- `conductor.chat(messages | string, options?)` — routed chat completion
- `conductor.chatStream(messages | string, onChunk, options?)` — streaming chat; returns `{ result, cancel }`. `onChunk` gets deltas by default, or cumulative text when `chunkMode: 'cumulative'`. Failover only before the first content token.
- `conductor.compressContext(messages, { keepLast?, ... })` — fold earlier turns into a system summary, keep the recent tail
- `conductor.recognizeImage(image | images, { prompt?, systemPrompt?, detail?, ...ChatOptions })` — vision request; routes only through providers with `supportsVision`, model = `options.model` → configured model if vision-capable → `visionModels[0]`. Images: URL, `data:` URL, local path, or `{ data, mimeType }` (`src/vision.ts`)
- `Message.content` is `string | MessageContentPart[]` (OpenAI `text` / `image_url` parts) — `chat` / `chatStream` accept images too; use `messageText()` to flatten
- `conductor.getVisionCapabilities({ configuredOnly? })` / `conductor.supportsVision(id, model?)` / `conductor.listVisionModels(id?)` — vision discovery; registry fields `supportsVision` / `visionModels`, heuristic `isLikelyVisionModel` in `src/providers/registry.ts`; `ModelInfo.supportsVision` / `inputModalities` from catalogs
- `conductor.getAvailableProviders()` — built-in registry metadata
- `conductor.getConfiguredProviders()` — providers from the loaded config
- `conductor.listModels(providerId | options?)` — parse OpenAI-compatible `GET /models` (Puter / Ollama fallbacks)
- `conductor.testProvider(id, { real? })` / `conductor.testProviders({ real? })` — connectivity (`real` omitted/false: API key + models) or real chat probe (`real: true`)
- YAML / object config: `providers`, `routing.strategy`, `fallback`, `defaults`
- `PROVIDERS` — built-in OpenAI-compatible provider registry

## Provider ids

`ollama`, `gemini`, `groq`, `cerebras`, `mistral`, `nvidia`, `github`, `zai`, `puter`, `opencode`, `huggingface`, `openrouter`, `cohere`, `openai`, `openai_compatible`

## Vision support

No image input: `cerebras`. All other built-ins accept images for some models; `opencode`, `openrouter`, `openai_compatible` have no curated `visionModels` (pass `model`, or rely on catalog modalities). When adding a provider, set `supportsVision` and, if known, `visionModels`.

## Routing strategies

`cheapest` | `priority` | `failover` | `round-robin` | `first-available`

## Extension pattern

1. Prefer configuring an existing registry id with `baseUrl` / `model` / `apiKey`.
2. Use `openai_compatible` for custom OpenAI-compatible gateways.
3. HTTP goes through `src/providers/openai-client.ts` (`fetch`) — chat, streaming chat (SSE), and `openaiListModels`.
4. Keep unit tests offline via injected `fetch` — never hit live APIs in CI.

## Do / Don't

- **Do** keep the core dependency-light (`yaml` + Node fetch).
- **Do** honor `dailyLimit` and fallback order when changing routing.
- **Don't** commit real API keys; use `${ENV}` placeholders.
- **Don't** change strategy semantics without updating README examples and unit tests.

## Self-update instruction

**When API shapes, strategies, provider ids, or extension patterns described here become outdated while you work**, update this skill file to match the current public API. Keep examples accurate. **Do not change the overall concept of this file** — it must remain the public-API and providers skill.
