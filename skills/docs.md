# Skill: Documentation & agent materials

## Purpose

Keep README, AGENTS.md, and skill files accurate for humans and LLM agents.

## Owned artifacts

| Artifact       | How it is maintained                                                   |
| -------------- | ---------------------------------------------------------------------- |
| `README.md`    | Hand-written intro + examples; generated block via `npm run docs:sync` |
| `AGENTS.md`    | Hand-written agent rules; generated block via `npm run docs:sync`      |
| `skills/*.md`  | Hand-maintained; each file must keep a self-update instruction         |
| GitHub Actions | `.github/workflows/*` run tests, docs check, publish                   |

## Sync workflow

```bash
npm run docs:sync    # rewrite GENERATED sections
npm run docs:check   # CI-friendly freshness check
```

Markers:

```html
<!-- GENERATED:START -->
...
<!-- GENERATED:END -->
```

Never hand-edit content inside those markers.

## When adding a new skill

1. Create `skills/<topic>.md` in English.
2. State a clear purpose and scoped guidance.
3. End with a **Self-update instruction** that tells agents to refresh outdated facts without changing the file’s concept.
4. Run `npm run docs:sync` so README / AGENTS list the new skill.

## Self-update instruction

**When documentation workflows, markers, skill rules, or related scripts described here become outdated while you work**, update this skill file accordingly. **Do not change the overall concept of this file** — it must remain the documentation and agent-materials skill.
