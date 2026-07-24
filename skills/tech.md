# Skill: Tech stack & project conventions

## Purpose

Describe the technical stack, directories, scripts, and conventions for **AI Conductor** so agents can work consistently.

## Stack

- **Language:** TypeScript (strict), ESM package (`"type": "module"`)
- **Runtime:** Node.js >= 18 (native `fetch`)
- **Build:** `tsup` → `dist/` (CJS + ESM + `.d.ts`)
- **Tests:** Jest + `ts-jest` (ESM), files in `tests/**/*.test.ts`
- **Lint / format:** ESLint 9 flat config + Prettier
- **Config:** YAML via `yaml` package (`configPath` or inline object)
- **CI:** GitHub Actions (test, docs check, publish)

## Directories

| Path                 | Role                                               |
| -------------------- | -------------------------------------------------- |
| `src/`               | Production source (`index.ts` is the public entry) |
| `src/providers/`     | Provider registry + OpenAI-compatible HTTP client  |
| `src/config/`        | YAML/object config loading                         |
| `src/routing/`       | Strategy ordering + daily usage tracker            |
| `tests/`             | Unit tests                                         |
| `examples/`          | Sample configs                                     |
| `skills/`            | Agent skill markdown files                         |
| `scripts/`           | Node maintenance scripts                           |
| `.github/workflows/` | CI / publish / docs                                |

## Essential commands

```bash
npm install
npm run typecheck
npm run lint
npm run format
npm test
npm run build
npm run docs:sync
npm run docs:check
npm run release
```

## Conventions

1. English only for code, comments, docs, and skills.
2. Prefer OpenAI-compatible HTTP (`fetch`) over vendor SDKs in core.
3. Do not call live AI APIs in unit tests — inject `fetch`.
4. After changing package metadata, scripts, or folder layout, run `npm run docs:sync`.
5. Generated README / AGENTS blocks (`<!-- GENERATED:* -->`) are machine-owned.

## Self-update instruction

**When any fact in this file becomes outdated while you work** (stack versions, scripts, directory roles, conventions), update this skill file to match reality. Refresh commands, paths, and tooling names as needed. **Do not change the overall concept of this file** — it must remain the tech-stack and conventions skill for AI Conductor.
