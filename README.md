# AI Conductor

[![CI](https://github.com/XXanderWP/ai-conductor/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/XXanderWP/ai-conductor/actions/workflows/ci.yml)
[![Publish](https://github.com/XXanderWP/ai-conductor/actions/workflows/publish.yml/badge.svg)](https://github.com/XXanderWP/ai-conductor/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/@xxanderwp/ai-conductor.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@xxanderwp/ai-conductor)
[![npm downloads](https://img.shields.io/npm/dm/@xxanderwp/ai-conductor.svg?logo=npm)](https://www.npmjs.com/package/@xxanderwp/ai-conductor)
[![Node.js](https://img.shields.io/node/v/@xxanderwp/ai-conductor.svg?logo=node.js&label=node)](https://www.npmjs.com/package/@xxanderwp/ai-conductor)
[![GitHub release](https://img.shields.io/github/v/release/XXanderWP/ai-conductor?logo=github&label=release)](https://github.com/XXanderWP/ai-conductor/releases)
[![License: MIT](https://img.shields.io/github/license/XXanderWP/ai-conductor)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

**Orchestrate any AI provider through one API.**

AI Conductor connects multiple OpenAI-compatible AI providers and routes chat requests through a single entry point. Prefer cheaper/free tiers with the `cheapest` strategy, spread load with round-robin, or fail over when a provider is rate-limited.

- **Author:** XXanderWP

## Install

```bash
npm install @xxanderwp/ai-conductor
```

## Quick start

```ts
import { Conductor } from '@xxanderwp/ai-conductor';

const conductor = new Conductor({
  configPath: './config.yml',
});

const response = await conductor.chat([
  { role: 'user', content: 'Summarize this ticket for support.' },
]);

console.log(response.content, response.provider, response.strategy);
```

Or configure entirely in code:

```ts
const conductor = new Conductor({
  providers: [
    { id: 'gemini', priority: 100, dailyLimit: 1000, apiKey: process.env.GEMINI_API_KEY },
    { id: 'groq', priority: 90, apiKey: process.env.GROQ_API_KEY },
  ],
  routing: { strategy: 'cheapest' },
  fallback: ['gemini', 'groq', 'openrouter'],
  apiKeys: {
    openrouter: process.env.OPENROUTER_API_KEY!,
  },
});
```

## YAML configuration

See [`examples/config.yml`](./examples/config.yml):

```yaml
providers:
  - id: gemini
    priority: 100
    dailyLimit: 1000
    apiKey: ${GEMINI_API_KEY}
    model: gemini-flash-latest

  - id: groq
    priority: 90
    apiKey: ${GROQ_API_KEY}

routing:
  strategy: cheapest

fallback:
  - gemini
  - groq
  - openrouter
```

`${ENV_VAR}` placeholders are expanded from the environment. Keys can also come from `apiKeys` in the constructor or common env vars (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`, `AI_CONDUCTOR_<ID>_API_KEY`, …).

## Built-in providers

Built-in OpenAI-compatible providers:

`ollama`, `gemini`, `groq`, `cerebras`, `mistral`, `nvidia`, `github`, `zai`, `puter`, `opencode`, `huggingface`, `openrouter`, `cohere`, `openai`, `openai_compatible`

## Routing strategies

| Strategy             | Behavior                                                      |
| -------------------- | ------------------------------------------------------------- |
| `cheapest` (default) | Prefer free-tier / likely-free models, then higher `priority` |
| `priority`           | Highest `priority` first                                      |
| `failover`           | Try providers in config order until one succeeds              |
| `round-robin`        | Rotate eligible providers                                     |
| `first-available`    | Always use the first eligible provider                        |

`fallback` appends extra providers after the primary ordered list. `dailyLimit` soft-skips a provider for the rest of the UTC day once the cap is reached.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
npm run docs:sync
```

### Playground (CLI TUI)

```bash
cp config.yml.example config.yml   # gitignored — add your keys
npm run playground
```

Commands inside the chat: `/status`, `/clear`, `/provider <id|auto>`, `/test-all` (confirm), `/quit` (Tab completes commands and provider ids).

## LLM agents

- [`AGENTS.md`](./AGENTS.md) — how agents should navigate this project
- [`skills/`](./skills/) — focused skill files (each includes a self-update instruction)

<!-- GENERATED:START -->

### Package

| Field   | Value                     |
| ------- | ------------------------- |
| Name    | `@xxanderwp/ai-conductor` |
| Version | `0.1.2`                   |
| Author  | XXanderWP                 |
| License | MIT                       |
| Node    | >=18                      |

### Repository layout

```text
.github/
.github/workflows/
.github/workflows/ci.yml
.github/workflows/publish.yml
scripts/
scripts/playground.mts
scripts/sync-docs.mjs
skills/
skills/api.md
skills/docs.md
skills/tech.md
src/
src/conductor.ts
src/config/
src/config/load.ts
src/config/types.ts
src/index.ts
src/providers/
src/providers/mock.ts
src/providers/openai-client.ts
src/providers/registry.ts
src/routing/
src/routing/order.ts
src/routing/usage.ts
src/types.ts
src/utils/
src/utils/suggest.ts
src/utils.ts
tests/
tests/conductor.test.ts
tests/suggest.test.ts
```

### Skills for LLM agents

- [`skills/api.md`](./skills/api.md)
- [`skills/docs.md`](./skills/docs.md)
- [`skills/tech.md`](./skills/tech.md)

### npm scripts

| Script                  | Purpose                                               |
| ----------------------- | ----------------------------------------------------- |
| `npm run build`         | Compile TypeScript to `dist/` (CJS + ESM + typings)   |
| `npm test`              | Run Jest unit tests                                   |
| `npm run test:coverage` | Run tests with coverage report                        |
| `npm run lint`          | ESLint check                                          |
| `npm run format`        | Format with Prettier                                  |
| `npm run typecheck`     | TypeScript `--noEmit` check                           |
| `npm run playground`    | Interactive CLI chat against root `config.yml`        |
| `npm run docs:sync`     | Refresh generated README / AGENTS sections            |
| `npm run docs:check`    | Fail if generated docs are stale                      |
| `npm run release`       | Publish to npm (`prepublishOnly` runs checks + build) |

<!-- GENERATED:END -->
