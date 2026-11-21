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

### Streaming

```ts
const { result, cancel } = conductor.chatStream(
  'Write a short poem',
  (text) => process.stdout.write(text), // delta chunks by default
);

// Or cumulative text so far:
// conductor.chatStream(prompt, onChunk, { chunkMode: 'cumulative' });

const response = await result;
// cancel() aborts the in-flight stream
```

Stream options (all optional):

| Option           | Default  | Meaning                                                                                           |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `chunkMode`      | `delta`  | `delta` pieces or `cumulative` text so far                                                        |
| `timeoutMs`      | `120000` | Wait for response **headers**                                                                     |
| `idleTimeoutMs`  | `60000`  | Abort when no bytes arrive for this long (keep-alive comments and reasoning count); `0` disables  |
| `totalTimeoutMs` | `300000` | Hard limit for the whole stream; `0` disables                                                     |
| `onReasoning`    | —        | Reasoning deltas (`reasoning`, `reasoning_content`, `reasoning_details`, stripped `<think>` text) |
| `onActivity`     | —        | `'reasoning' \| 'text' \| 'tool'` for every chunk of that kind (e.g. a "thinking…" indicator)     |
| `stripThinking`  | `false`  | Remove `<think>…</think>` from `content` and streamed text (an unclosed block stays hidden)       |
| `onToolCall`     | —        | Each finished tool call, once, when the stream ends                                               |

A watchdog abort rejects with `ConductorError` `code: 'stalled'` and `partialContent` (text received so far); a user abort (`cancel()` or `signal`) rejects with `code: 'aborted'`. Usage is filled for streams too: providers with `supportsStreamUsage` get `stream_options: { include_usage: true }`.

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

## Providers, models, and probes

```ts
// Built-in registry vs current config
conductor.getAvailableProviders();
conductor.getConfiguredProviders();

// Parse OpenAI-compatible model catalogs
const geminiModels = await conductor.listModels('gemini');
const allModels = await conductor.listModels();

// Connectivity (API key + /models) vs real chat
await conductor.testProvider('gemini'); // real omitted → connectivity
await conductor.testProvider('gemini', { real: true });
await conductor.testProviders({ real: true });
```

## Compress dialog context

```ts
const { messages } = await conductor.compressContext(history, {
  keepLast: 4, // keep the last 4 user/assistant messages
});
// messages[0] is a system note about earlier turns; the rest is the recent tail
```

## Tool calling

OpenAI-compatible function calling: pass `tools` (and optionally `toolChoice` / `parallelToolCalls`), run the requested tools yourself, push the results into history and call again. The library only transports calls and results — it never executes tools.

```ts
import {
  Conductor,
  assistantMessageFromResponse,
  toolResultMessage,
  type Message,
  type ToolDefinition,
} from '@xxanderwp/ai-conductor';

const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Current weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  },
];

async function runTool(name: string, args: Record<string, unknown>): Promise<object> {
  if (name === 'get_weather') return { city: args.city, tempC: 21, sky: 'sunny' };
  return { error: `Unknown tool ${name}` };
}

const history: Message[] = [{ role: 'user', content: 'What is the weather in Berlin?' }];

for (let step = 0; step < 5; step += 1) {
  const res = await conductor.chat(history, { tools, toolChoice: 'auto' });
  history.push(assistantMessageFromResponse(res)); // keeps tool_calls + extra_content

  if (!res.toolCalls?.length) {
    console.log(res.content); // final answer
    break;
  }

  for (const call of res.toolCalls) {
    const output = await runTool(call.function.name, JSON.parse(call.function.arguments || '{}'));
    history.push(toolResultMessage(call.id, output)); // objects are JSON.stringify-ed
  }
}
```

Streaming works the same way: text deltas go to `onChunk`, tool call fragments are assembled internally and reported once each via `onToolCall` when the stream ends.

```ts
const { result } = conductor.chatStream(history, (text) => process.stdout.write(text), {
  tools,
  onToolCall: (call) => console.log('\n→', call.function.name, call.function.arguments),
});

const res = await result; // res.toolCalls, res.finishReason ('tool_calls' | 'stop' | …)
history.push(assistantMessageFromResponse(res));
for (const call of res.toolCalls ?? []) {
  history.push(
    toolResultMessage(
      call.id,
      await runTool(call.function.name, JSON.parse(call.function.arguments || '{}')),
    ),
  );
}
```

Notes:

- `ChatResponse.content` is always a string (`''` when the model returned only tool calls); `toolCalls` / `finishReason` are set when the provider reports them.
- **Keep `extra_content` and send it back unchanged.** Some providers attach opaque data to tool calls (Gemini `extra_content.google.thought_signature`) and reject the follow-up request without it. `assistantMessageFromResponse` keeps it for you.
- **History with tool calls is pinned to one provider.** Tool call ids and signatures belong to the provider that issued them, so requests whose history contains tool calls / results do not fail over to another provider. The Conductor routes them to the provider and model that issued the calls (also exposed as `res.provider` / `res.model`). Pass `options.provider` to choose explicitly, or `allowToolFailover: true` to allow failover anyway.
- With `tools`, providers whose `supportsTools` is `false` are skipped (registry `PROVIDERS[id].supportsTools`, overridable per config entry with `supportsTools: false` for models without tool support).
- Helpers: `isToolCallMessage`, `isToolResultMessage`, `toolResultMessage`, `assistantMessageFromResponse`. `compressContext` never splits a tool call from its results.

## Image recognition (vision)

```ts
// Describe / analyze images: URL, data: URL, local file path, or { data, mimeType }
const { content, provider, model } = await conductor.recognizeImage('./receipt.jpg', {
  prompt: 'Extract the total amount.',
  detail: 'high', // optional OpenAI-style hint
});

// Several images in one request
await conductor.recognizeImage([
  'https://example.com/a.png',
  { data: pngBytes, mimeType: 'image/png' },
]);

// Images also work in regular chat via OpenAI-compatible content parts
await conductor.chat([
  {
    role: 'user',
    content: [
      { type: 'text', text: 'What is on this picture?' },
      { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } },
    ],
  },
]);
```

`recognizeImage` follows the routing strategy but skips providers without image input. Per provider it uses `options.model`, else the configured model if it supports vision, else the first registry `visionModels` entry.

Which provider / model supports images:

```ts
conductor.getVisionCapabilities(); // every built-in provider
conductor.getVisionCapabilities({ configuredOnly: true });
// → [{ provider: 'groq', supportsVision: true, visionModels: [...], configured: true,
//      model: 'llama-3.1-8b-instant', modelSupportsVision: false,
//      recognitionModel: 'meta-llama/llama-4-scout-17b-16e-instruct' }, ...]

conductor.supportsVision('cerebras'); // false
conductor.supportsVision('openai', 'gpt-4o-mini'); // true (heuristic)

// Live catalog filtered to image-capable models (uses catalog modalities when reported,
// e.g. OpenRouter; name heuristics otherwise). listModels() also sets `supportsVision`.
await conductor.listVisionModels('openrouter');
await conductor.listVisionModels();
```

Static metadata is also on `PROVIDERS[id].supportsVision` / `visionModels`, and `isLikelyVisionModel(provider, model)` is exported.

## Embedding in a host app

When a host app (e.g. an Electron main process) keeps its own routing, quotas and context compaction, use AI Conductor as a per-profile transport:

```ts
import { Conductor, isConductorError } from '@xxanderwp/ai-conductor';

const conductor = new Conductor({
  env: false, // never read GEMINI_API_KEY etc. from the user's environment; `${VAR}` stays as is
  providers: [
    // Several profiles of one provider type: `id` is a free-form instance id
    { id: 'gemini-work', provider: 'gemini', apiKey: workKey, model: 'gemini-flash-latest' },
    { id: 'gemini-home', provider: 'gemini', apiKey: homeKey, model: 'gemini-flash-latest' },
    {
      id: 'gateway',
      provider: 'openai_compatible',
      baseUrl: 'http://localhost:8080/v1',
      model: 'local',
    }, // anonymous: no Authorization header
  ],
  onResponse: (e) => {
    // after every HTTP attempt: persist quotas / headers in the host
    quotas.record(e.provider, {
      status: e.status,
      headers: e.headers,
      usage: e.usage,
      ms: e.durationMs,
    });
  },
  usageStore: myPersistentStore, // optional: { get(id), set(id, state), delete?(id) }
});

const controller = new AbortController();
try {
  const res = await conductor.chat(history, {
    provider: 'gemini-work',
    fallback: false, // exactly this instance, once: no strategy, no fallback list, no retries
    signal: controller.signal,
    headers: { 'x-request-id': requestId },
    extraBody: { safety_settings: [] }, // merged into the body last
    reasoningEffort: 'low', // sent only where supportsReasoningEffort
  });
  console.log(res.provider, res.providerType, res.model, res.usage, res.headers);
} catch (error) {
  if (isConductorError(error)) {
    switch (error.code) {
      case 'rate_limited':
        cooldown(error.provider, error.retryAfterSec);
        break;
      case 'context_overflow':
        await compactHistory();
        break;
      case 'auth':
        markKeyInvalid(error.provider);
        break;
      case 'aborted':
        break;
      default:
        log(error.code, error.status, error.message, error.body, error.attempts);
    }
  }
}

// Swap profiles at runtime; counters of surviving instance ids are kept
await conductor.updateConfig({ providers: nextProfiles, apiKeys: nextKeys });
```

- **Instances:** `{ id, provider }` entries; `options.provider`, `fallback`, `apiKeys`, `dailyLimit`, usage counters and `listModels` / `testProvider` all take the instance id. `ChatResponse.provider` is the instance id, `providerType` the registry id. Duplicate ids are a config error.
- **`fallback: false`** calls exactly one instance once. `retries: n` (any mode) retries the same instance on retryable errors. A requested instance over its `dailyLimit` rejects with `code: 'daily_limit'`.
- **`ConductorError`** (`chat`, `chatStream().result`, config errors): `code` is one of `http`, `rate_limited`, `context_overflow`, `aborted`, `stalled`, `timeout`, `network`, `auth`, `daily_limit`, `config`, `no_provider`; plus `status`, `provider`, `providerType`, `model`, `retryAfterSec` (`Retry-After`, `retry-after-ms`, exhausted `x-ratelimit-reset-*`, Gemini `RetryInfo`), `headers`, `body`, `partialContent`, `attempts`.
- **`signal`** works for `chat`, `chatStream`, `listModels`, `testProvider`, `compressContext`, `recognizeImage`; listeners are removed when the request ends.
- **`env`**: `true` (default) = `process.env`, `false` = no env lookup and no `${VAR}` expansion (placeholders are left unexpanded), or an explicit `{ NAME: value }` map.
- **Headers / body:** `ProviderConfig.headers` and `ChatOptions.headers` (request wins) override built-in defaults such as OpenRouter `HTTP-Referer`. `metadata` is spread right after `model` / `messages`; `extraBody` is merged last and overrides everything.
- **Catalog:** `listModels` adds `contextLength`, `supportsTools` and `isFree` when the catalog reports them; `{ details: true }` also sets `isFree` from the `isLikelyFreeModel` heuristic and `raw`. `detectOllama(baseUrl?, { timeoutMs, signal })` checks a local Ollama server.
- `parseRateLimitHeaders(headers)` → `{ remainingRequests, remainingTokens, resetRequestsMs, resetTokensMs, retryAfterSec }`.

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
| Version | `0.3.0`                   |
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
src/errors.ts
src/index.ts
src/providers/
src/providers/mock.ts
src/providers/openai-client.ts
src/providers/registry.ts
src/ratelimit.ts
src/routing/
src/routing/order.ts
src/routing/usage.ts
src/think.ts
src/types.ts
src/utils/
src/utils/suggest.ts
src/utils.ts
src/vision.ts
tests/
tests/conductor.test.ts
tests/embedding.test.ts
tests/suggest.test.ts
tests/tools.test.ts
tests/types-compat.test.ts
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
