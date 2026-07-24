#!/usr/bin/env node
/**
 * Interactive CLI playground for AI Conductor.
 *
 * Loads `./config.yml` from the project root (gitignored).
 * Copy from `examples/config.yml` if missing.
 *
 * Usage:
 *   npm run playground
 *   npm run playground -- --config ./my-config.yml
 *
 * Tab completes slash-commands and configured provider ids.
 */

import { access } from 'node:fs/promises';
import path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output } from 'node:process';
import {
  Conductor,
  formatSuggestions,
  isProviderId,
  PROVIDERS,
  type Message,
} from '../src/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const COMMANDS = [
  '/help',
  '/status',
  '/clear',
  '/provider',
  '/test-all',
  '/quit',
  '/exit',
] as const;

const TEST_PROMPT = 'Reply with exactly: ok';

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

function paint(color: keyof typeof c, text: string): string {
  return `${c[color]}${text}${c.reset}`;
}

function parseArgs(argv: string[]): { configPath: string; help: boolean } {
  let configPath = path.join(root, 'config.yml');
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--config' || arg === '-c') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('Missing value for --config');
      }
      configPath = path.resolve(root, next);
      i += 1;
    }
  }
  return { configPath, help };
}

function printHelp(providerIds: string[]): void {
  console.log(`
${paint('bold', 'AI Conductor Playground')}

Usage:
  npm run playground
  npm run playground -- --config ./config.yml

Commands inside the chat (Tab to autocomplete):
  /status              Show strategy, providers, daily usage
  /clear               Clear conversation history
  /provider <id>       Force next replies through one provider (or "auto")
  /test-all            Probe every configured provider (asks for confirmation)
  /quit  /exit         Leave the playground

Configured providers: ${providerIds.join(', ') || '(none)'}
`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function configuredProviderIds(conductor: Conductor): string[] {
  return conductor
    .getConfig()
    .providers.filter((p) => p.enabled !== false)
    .map((p) => p.id);
}

function createCompleter(providerIds: string[]) {
  const providerChoices = ['auto', ...providerIds];

  return (line: string): [string[], string] => {
    const trimmedStart = line.match(/^\s*/)?.[0] ?? '';
    const body = line.slice(trimmedStart.length);

    if (body.startsWith('/provider')) {
      const rest = body.slice('/provider'.length);
      if (rest === '' || rest.startsWith(' ')) {
        const partial = rest.trimStart();
        const hits = providerChoices.filter((id) => id.startsWith(partial));
        const completions =
          hits.length > 0
            ? hits.map((id) => `${trimmedStart}/provider ${id}`)
            : providerChoices.map((id) => `${trimmedStart}/provider ${id}`);
        return [completions, line];
      }
    }

    if (body.startsWith('/')) {
      const hits = COMMANDS.filter((cmd) => cmd.startsWith(body));
      const completions = (hits.length ? hits : [...COMMANDS]).map(
        (cmd) => `${trimmedStart}${cmd}${cmd === '/provider' ? ' ' : ''}`,
      );
      return [completions, line];
    }

    return [[], line];
  };
}

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const onClose = () => reject(new Error('closed'));
    rl.once('close', onClose);
    rl.question(prompt, (answer) => {
      rl.off('close', onClose);
      resolve(answer);
    });
  });
}

function printBanner(configPath: string, conductor: Conductor): void {
  const providers = configuredProviderIds(conductor).join(', ');

  console.log();
  console.log(paint('bold', '┌─ AI Conductor Playground ─────────────────────────'));
  console.log(paint('dim', `│ config   ${configPath}`));
  console.log(paint('dim', `│ strategy ${conductor.getStrategy()}`));
  console.log(paint('dim', `│ providers ${providers || '(none)'}`));
  console.log(paint('dim', '│ Tab completes commands / provider ids · /help'));
  console.log(paint('bold', '└───────────────────────────────────────────────────'));
  console.log();
}

function printStatus(conductor: Conductor, forcedProvider: string | undefined): void {
  const config = conductor.getConfig();
  console.log(paint('cyan', '\n── status ──'));
  console.log(`strategy: ${conductor.getStrategy()}`);
  console.log(`forced:   ${forcedProvider ?? 'auto'}`);
  console.log('providers:');
  for (const provider of config.providers) {
    const used = conductor.getDailyUsage(provider.id);
    const limit = provider.dailyLimit != null ? String(provider.dailyLimit) : '∞';
    const enabled = provider.enabled === false ? 'off' : 'on';
    console.log(
      `  - ${provider.id}  priority=${provider.priority ?? 'default'}  usage=${used}/${limit}  ${enabled}`,
    );
  }
  if (config.fallback?.length) {
    console.log(`fallback: ${config.fallback.join(' → ')}`);
  }
  console.log();
}

function resolveProviderOverride(
  rawId: string,
  providerIds: string[],
): { ok: true; id?: string } | { ok: false; message: string } {
  if (!rawId || rawId === 'auto') {
    return { ok: true, id: undefined };
  }

  if (!isProviderId(rawId)) {
    const known = Object.keys(PROVIDERS);
    return {
      ok: false,
      message: `Unknown provider id "${rawId}". ${formatSuggestions(rawId, known)}`,
    };
  }

  if (!providerIds.includes(rawId)) {
    return {
      ok: false,
      message: `Provider "${rawId}" is not in the current config. ${formatSuggestions(rawId, providerIds)}`,
    };
  }

  return { ok: true, id: rawId };
}

async function confirm(rl: readline.Interface, question: string): Promise<boolean> {
  const answer = (await ask(rl, paint('yellow', question))).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

type ProviderProbeResult = {
  id: string;
  ok: boolean;
  ms: number;
  model?: string;
  preview?: string;
  error?: string;
};

async function testAllProviders(
  conductor: Conductor,
  providerIds: string[],
): Promise<ProviderProbeResult[]> {
  const results: ProviderProbeResult[] = [];

  for (const id of providerIds) {
    process.stdout.write(paint('dim', `▸ probing ${id}… `));
    const started = Date.now();
    try {
      const response = await conductor.chat(TEST_PROMPT, { provider: id });
      const ms = Date.now() - started;
      const preview = response.content.replace(/\s+/g, ' ').trim().slice(0, 80);
      console.log(paint('green', `ok (${ms}ms)`));
      if (preview) {
        console.log(paint('dim', `  ${preview}`));
      }
      results.push({
        id,
        ok: true,
        ms,
        model: response.model,
        preview,
      });
    } catch (error) {
      const ms = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);
      console.log(paint('red', `fail (${ms}ms)`));
      console.log(paint('red', `  ${message}`));
      results.push({ id, ok: false, ms, error: message });
    }
  }

  return results;
}

function printProbeSummary(results: ProviderProbeResult[]): void {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(paint('cyan', '\n── test-all summary ──'));
  for (const result of results) {
    const mark = result.ok ? paint('green', 'PASS') : paint('red', 'FAIL');
    const detail = result.ok
      ? `${result.model ?? 'unknown model'} · ${result.ms}ms`
      : `${result.ms}ms · ${result.error}`;
    console.log(`  ${mark}  ${result.id}  ${paint('dim', detail)}`);
  }
  console.log(
    paint(
      failed === 0 ? 'green' : 'yellow',
      `\n${passed}/${results.length} providers responded successfully.\n`,
    ),
  );
}

async function main(): Promise<void> {
  const { configPath, help } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp(Object.keys(PROVIDERS));
    return;
  }

  if (!(await fileExists(configPath))) {
    console.error(paint('red', `Config not found: ${configPath}`));
    console.error(
      paint(
        'yellow',
        'Copy config.yml.example → config.yml at the project root (config.yml is gitignored), then fill in API keys.',
      ),
    );
    process.exitCode = 1;
    return;
  }

  const conductor = new Conductor({ configPath });
  await conductor.whenReady();
  const providerIds = configuredProviderIds(conductor);

  const rl = readline.createInterface({
    input,
    output,
    terminal: true,
    completer: createCompleter(providerIds),
  });

  const history: Message[] = [];
  let forcedProvider: string | undefined;

  printBanner(configPath, conductor);

  const shutdown = () => {
    console.log(paint('dim', '\nBye.'));
    rl.close();
  };

  process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
  });

  while (true) {
    let line: string;
    try {
      line = (await ask(rl, paint('green', 'you › '))).trim();
    } catch {
      break;
    }

    if (!line) {
      continue;
    }

    if (line === '/quit' || line === '/exit') {
      shutdown();
      break;
    }
    if (line === '/help') {
      printHelp(providerIds);
      continue;
    }
    if (line === '/clear') {
      history.length = 0;
      console.log(paint('dim', 'Conversation cleared.\n'));
      continue;
    }
    if (line === '/status') {
      printStatus(conductor, forcedProvider);
      continue;
    }
    if (line === '/test-all') {
      if (providerIds.length === 0) {
        console.log(paint('yellow', 'No enabled providers in config.\n'));
        continue;
      }
      console.log(
        paint(
          'yellow',
          `\nThis will send "${TEST_PROMPT}" to each configured provider (${providerIds.join(', ')}).`,
        ),
      );
      const ok = await confirm(rl, 'Continue? [y/N] › ');
      if (!ok) {
        console.log(paint('dim', 'Cancelled.\n'));
        continue;
      }
      console.log();
      const results = await testAllProviders(conductor, providerIds);
      printProbeSummary(results);
      continue;
    }
    if (line.startsWith('/provider')) {
      const id = line.slice('/provider'.length).trim();
      const resolved = resolveProviderOverride(id, providerIds);
      if (!resolved.ok) {
        console.log(paint('red', `${resolved.message}\n`));
        continue;
      }
      forcedProvider = resolved.id;
      if (!forcedProvider) {
        console.log(paint('dim', 'Provider override cleared (auto routing).\n'));
      } else {
        console.log(paint('dim', `Next replies forced to provider "${forcedProvider}".\n`));
      }
      continue;
    }
    if (line.startsWith('/')) {
      const suggestions = COMMANDS.filter((cmd) => cmd.startsWith(line) || line.startsWith(cmd));
      const hint = suggestions.length
        ? `Try: ${suggestions.join(', ')}`
        : 'Try /help (Tab completes commands).';
      console.log(paint('yellow', `Unknown command: ${line}. ${hint}\n`));
      continue;
    }

    history.push({ role: 'user', content: line });
    const started = Date.now();
    process.stdout.write(paint('dim', 'thinking…\n'));

    try {
      const response = await conductor.chat(history, {
        provider: forcedProvider,
      });
      const ms = Date.now() - started;
      history.push({ role: 'assistant', content: response.content });

      console.log();
      console.log(
        paint(
          'magenta',
          `conductor › ${response.provider}${response.model ? ` / ${response.model}` : ''} · ${response.strategy} · ${ms}ms`,
        ),
      );
      if (response.failedProviders?.length) {
        console.log(paint('yellow', `failed before: ${response.failedProviders.join(' → ')}`));
      }
      console.log(response.content);
      console.log();
    } catch (error) {
      history.pop();
      const message = error instanceof Error ? error.message : String(error);
      console.log(paint('red', `\nerror › ${message}\n`));
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(paint('red', message));
  process.exitCode = 1;
});
