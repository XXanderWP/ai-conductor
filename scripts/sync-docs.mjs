#!/usr/bin/env node
/**
 * Sync generated documentation sections in README.md and AGENTS.md.
 *
 * Usage:
 *   node scripts/sync-docs.mjs          # write updates
 *   node scripts/sync-docs.mjs --check  # exit 1 if docs are stale
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const checkOnly = process.argv.includes('--check');

const GENERATED_START = '<!-- GENERATED:START -->';
const GENERATED_END = '<!-- GENERATED:END -->';

async function formatMarkdown(filePath, content) {
  const config = (await prettier.resolveConfig(filePath)) ?? {};
  return prettier.format(content, { ...config, filepath: filePath });
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listTree(dir, prefix = '') {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  const lines = [];
  const sorted = entries
    .filter((e) => !['node_modules', 'dist', 'coverage', '.git'].includes(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of sorted) {
    const rel = path.posix.join(prefix || dir, entry.name);
    if (entry.isDirectory()) {
      lines.push(`${rel}/`);
      lines.push(...(await listTree(path.join(dir, entry.name), rel)));
    } else {
      lines.push(rel);
    }
  }
  return lines;
}

async function listSkills() {
  const skillsDir = path.join(root, 'skills');
  if (!(await exists(skillsDir))) {
    return [];
  }
  const files = await readdir(skillsDir);
  return files.filter((f) => f.endsWith('.md')).sort();
}

function replaceGenerated(content, body) {
  const block = `${GENERATED_START}\n${body.trim()}\n${GENERATED_END}`;
  if (content.includes(GENERATED_START) && content.includes(GENERATED_END)) {
    return content.replace(new RegExp(`${GENERATED_START}[\\s\\S]*?${GENERATED_END}`, 'm'), block);
  }
  return `${content.trimEnd()}\n\n${block}\n`;
}

async function buildReadmeGenerated() {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const tree = (await listTree('.')).filter((line) =>
    /^(src|tests|skills|scripts|\.github)\b/.test(line),
  );
  const skills = await listSkills();

  return `
### Package

| Field | Value |
| --- | --- |
| Name | \`${pkg.name}\` |
| Version | \`${pkg.version}\` |
| Author | ${pkg.author} |
| License | ${pkg.license} |
| Node | ${pkg.engines?.node ?? 'n/a'} |

### Repository layout

\`\`\`text
${tree.join('\n')}
\`\`\`

### Skills for LLM agents

${
  skills.length
    ? skills.map((s) => `- [\`skills/${s}\`](./skills/${s})`).join('\n')
    : '_No skill files yet._'
}

### npm scripts

| Script | Purpose |
| --- | --- |
| \`npm run build\` | Compile TypeScript to \`dist/\` (CJS + ESM + typings) |
| \`npm test\` | Run Jest unit tests |
| \`npm run test:coverage\` | Run tests with coverage report |
| \`npm run lint\` | ESLint check |
| \`npm run format\` | Format with Prettier |
| \`npm run typecheck\` | TypeScript \`--noEmit\` check |
| \`npm run docs:sync\` | Refresh generated README / AGENTS sections |
| \`npm run docs:check\` | Fail if generated docs are stale |
| \`npm run release\` | Publish to npm (\`prepublishOnly\` runs checks + build) |
`.trim();
}

async function buildAgentsGenerated() {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const skills = await listSkills();

  return `
## Auto-synced project facts

- Package: \`${pkg.name}@${pkg.version}\`
- Author: ${pkg.author}
- License: ${pkg.license}
- Entry: \`src/index.ts\` → \`dist/\`
- Tests: \`tests/**/*.test.ts\`
- Skills directory: \`skills/\`

### Available skills

${
  skills.length
    ? skills.map((s) => `- \`skills/${s}\` — read before related work; update if stale`).join('\n')
    : '_None_'
}

### Required agent workflow

1. Read \`skills/tech.md\` before making changes.
2. Keep public API, README examples, and tests aligned.
3. Run \`npm run docs:sync\` after structural or script changes.
4. Never change skill file *concept*; only refresh outdated facts.
`.trim();
}

async function syncFile(relativePath, generatedBody) {
  const filePath = path.join(root, relativePath);
  const current = (await exists(filePath)) ? await readFile(filePath, 'utf8') : '';
  const merged = replaceGenerated(current, generatedBody);
  const next = await formatMarkdown(filePath, merged);

  if (current === next) {
    console.log(`OK  ${relativePath} (up to date)`);
    return true;
  }

  if (checkOnly) {
    console.error(`STALE ${relativePath}`);
    return false;
  }

  await writeFile(filePath, next, 'utf8');
  console.log(`UPD ${relativePath}`);
  return true;
}

const readmeOk = await syncFile('README.md', await buildReadmeGenerated());
const agentsOk = await syncFile('AGENTS.md', await buildAgentsGenerated());

if (checkOnly && (!readmeOk || !agentsOk)) {
  console.error('\nDocs are stale. Run: npm run docs:sync');
  process.exit(1);
}
