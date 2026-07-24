# Skill: Public API & providers

## Purpose

Guide agents implementing or extending the AI Conductor public API and provider adapters.

## Core API

- `Conductor` — main orchestrator (`new Conductor({ configPath })` or inline options)
- `conductor.chat(messages | string, options?)` — routed chat completion
- YAML / object config: `providers`, `routing.strategy`, `fallback`, `defaults`
- `PROVIDERS` — built-in OpenAI-compatible registry (StreamKitPlus-compatible ids)

## Provider ids

`ollama`, `gemini`, `groq`, `cerebras`, `mistral`, `nvidia`, `github`, `zai`, `puter`, `opencode`, `huggingface`, `openrouter`, `cohere`, `openai`, `openai_compatible`

## Routing strategies

`cheapest` | `priority` | `failover` | `round-robin` | `first-available`

## Extension pattern

1. Prefer configuring an existing registry id with `baseUrl` / `model` / `apiKey`.
2. Use `openai_compatible` for custom OpenAI-compatible gateways.
3. HTTP goes through `src/providers/openai-client.ts` (`fetch`).
4. Keep unit tests offline via injected `fetch` — never hit live APIs in CI.

## Do / Don't

- **Do** keep the core dependency-light (`yaml` + Node fetch).
- **Do** honor `dailyLimit` and fallback order when changing routing.
- **Don't** commit real API keys; use `${ENV}` placeholders.
- **Don't** change strategy semantics without updating README examples and unit tests.

## Self-update instruction

**When API shapes, strategies, provider ids, or extension patterns described here become outdated while you work**, update this skill file to match the current public API. Keep examples accurate. **Do not change the overall concept of this file** — it must remain the public-API and providers skill.
