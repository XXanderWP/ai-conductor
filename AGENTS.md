# AGENTS.md

Guidance for LLM coding agents working on **AI Conductor**.

## Mission

AI Conductor orchestrates OpenAI-compatible AI providers through one API (`Conductor.chat`), with YAML/declarative routing (`cheapest`, priority, failover, daily limits).

## Language

All code, documentation, comments, commit messages in this repository, and skill files must be written in **English**.

## Layout

| Path                 | Purpose                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `src/`               | Library source (`conductor.ts`, `providers/`, `config/`, `routing/`) |
| `tests/`             | Jest unit tests (inject `fetch`; no live APIs)                       |
| `skills/`            | Agent skill files                                                    |
| `scripts/`           | Maintenance scripts (docs sync)                                      |
| `examples/`          | Sample YAML configs                                                  |
| `.github/workflows/` | CI, publish, docs checks                                             |

## Before you change code

1. Read [`skills/tech.md`](./skills/tech.md).
2. Skim [`skills/api.md`](./skills/api.md) for the public surface and provider list.
3. Prefer extending the OpenAI-compatible client / registry over inventing new HTTP stacks.

## Quality bar

- TypeScript strict mode; no `any` unless unavoidable and documented.
- Unit tests for new behavior under `tests/`.
- `npm run typecheck && npm run lint && npm test` before finishing.
- After layout / script / metadata changes: `npm run docs:sync`.

## Updating agent materials

- Keep this file and skill files accurate. When facts become outdated during work, update them **without changing the file’s overall concept**.
- Skill files include an explicit self-update instruction — follow it.
- Generated sections between `<!-- GENERATED:START -->

## Auto-synced project facts

- Package: `@xxanderwp/ai-conductor@0.1.4`
- Author: XXanderWP
- License: MIT
- Entry: `src/index.ts` → `dist/`
- Tests: `tests/**/*.test.ts`
- Skills directory: `skills/`

### Available skills

- `skills/api.md` — read before related work; update if stale
- `skills/docs.md` — read before related work; update if stale
- `skills/tech.md` — read before related work; update if stale

### Required agent workflow

1. Read `skills/tech.md` before making changes.
2. Keep public API, README examples, and tests aligned.
3. Run `npm run docs:sync` after structural or script changes.
4. Never change skill file _concept_; only refresh outdated facts.

<!-- GENERATED:END -->` are owned by `npm run docs:sync`. Do not hand-edit those blocks; edit the surrounding prose instead.

## Public API notes

- Construct with `configPath` and/or inline `providers` / `routing` / `fallback` / `apiKeys`.
- Provider registry lives in `src/providers/registry.ts`.
- Strategies: `cheapest`, `priority`, `failover`, `round-robin`, `first-available`.
- Discovery / probes: `getAvailableProviders`, `getConfiguredProviders`, `listModels`, `testProvider` / `testProviders` (`real?: boolean`).
- Context: `compressContext(messages, { keepLast? })` folds earlier turns into a system summary.

<!-- GENERATED:START -->
<!-- GENERATED:END -->
