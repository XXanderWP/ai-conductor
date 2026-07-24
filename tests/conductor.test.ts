import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Conductor, normalizeConfig, PROVIDERS } from '../src/index';
import { scoreCheapest } from '../src/routing/order';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('normalizeConfig', () => {
  it('parses provider priority, dailyLimit, and cheapest strategy', () => {
    const config = normalizeConfig({
      providers: [
        { id: 'gemini', priority: 100, dailyLimit: 1000 },
        { id: 'groq', priority: 90 },
      ],
      routing: { strategy: 'cheapest' },
      fallback: ['gemini', 'groq', 'openrouter'],
    });

    expect(config.providers).toHaveLength(2);
    expect(config.providers[0]).toMatchObject({
      id: 'gemini',
      priority: 100,
      dailyLimit: 1000,
    });
    expect(config.routing?.strategy).toBe('cheapest');
    expect(config.fallback).toEqual(['gemini', 'groq', 'openrouter']);
  });

  it('rejects unknown provider ids', () => {
    expect(() =>
      normalizeConfig({
        providers: [{ id: 'not-a-provider' }],
      }),
    ).toThrow(/Invalid provider id/);
  });
});

describe('provider registry', () => {
  it('includes the StreamKitPlus provider set', () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual(
      [
        'cerebras',
        'cohere',
        'gemini',
        'github',
        'groq',
        'huggingface',
        'mistral',
        'nvidia',
        'ollama',
        'openai',
        'openai_compatible',
        'opencode',
        'openrouter',
        'puter',
        'zai',
      ].sort(),
    );
  });
});

describe('cheapest scoring', () => {
  it('prefers free gemini over paid openai', () => {
    const gemini = scoreCheapest({ id: 'gemini', priority: 50, model: 'gemini-flash-latest' });
    const openai = scoreCheapest({
      id: 'openai',
      priority: 100,
      model: 'gpt-4o-mini',
      isPaid: true,
    });
    expect(gemini).toBeGreaterThan(openai);
  });
});

describe('Conductor', () => {
  it('loads YAML config and chats through the cheapest eligible provider', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ai-conductor-'));
    const configPath = path.join(dir, 'config.yml');
    await writeFile(
      configPath,
      `
providers:
  - id: gemini
    priority: 100
    dailyLimit: 1000
    apiKey: test-gemini
    model: gemini-flash-latest
  - id: groq
    priority: 90
    apiKey: test-groq
    model: llama-3.1-8b-instant
routing:
  strategy: cheapest
fallback:
  - gemini
  - groq
`,
      'utf8',
    );

    const calls: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('generativelanguage.googleapis.com')) {
        calls.push('gemini');
        return jsonResponse({
          choices: [{ message: { content: 'hello from gemini' } }],
          model: 'gemini-flash-latest',
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        });
      }
      calls.push('other');
      return jsonResponse({ error: { message: 'unexpected' } }, 500);
    };

    const conductor = new Conductor({ configPath, fetch: fetchMock });
    const response = await conductor.chat('Hi');

    expect(response.content).toBe('hello from gemini');
    expect(response.provider).toBe('gemini');
    expect(response.strategy).toBe('cheapest');
    expect(calls).toEqual(['gemini']);
    expect(conductor.getDailyUsage('gemini')).toBe(1);
  });

  it('falls over to the next provider on failure', async () => {
    const conductor = new Conductor({
      providers: [
        { id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest', priority: 100 },
        { id: 'groq', apiKey: 'q', model: 'llama-3.1-8b-instant', priority: 90 },
      ],
      routing: { strategy: 'failover' },
      fallback: ['gemini', 'groq'],
      fetch: async (input) => {
        const url = String(input);
        if (url.includes('generativelanguage')) {
          return jsonResponse({ error: { message: 'quota' } }, 429, { 'retry-after': '1' });
        }
        return jsonResponse({
          choices: [{ message: { content: 'from groq' } }],
          model: 'llama-3.1-8b-instant',
        });
      },
    });

    const response = await conductor.chat([{ role: 'user', content: 'ping' }]);
    expect(response.provider).toBe('groq');
    expect(response.failedProviders).toEqual(['gemini']);
    expect(response.content).toBe('from groq');
  });

  it('skips providers that hit dailyLimit', async () => {
    const conductor = new Conductor({
      providers: [
        { id: 'gemini', apiKey: 'g', model: 'm', priority: 100, dailyLimit: 1 },
        { id: 'groq', apiKey: 'q', model: 'm', priority: 90 },
      ],
      routing: { strategy: 'priority' },
      fetch: async (input) => {
        const provider = String(input).includes('generativelanguage') ? 'gemini' : 'groq';
        return jsonResponse({
          choices: [{ message: { content: provider } }],
          model: 'm',
        });
      },
    });

    const first = await conductor.chat('one');
    const second = await conductor.chat('two');

    expect(first.provider).toBe('gemini');
    expect(second.provider).toBe('groq');
  });

  it('accepts inline init without a config file', async () => {
    const conductor = new Conductor({
      providers: [{ id: 'ollama', model: 'llama3.2', priority: 1 }],
      routing: { strategy: 'first-available' },
      fetch: async () =>
        jsonResponse({
          choices: [{ message: { content: 'local' } }],
          model: 'llama3.2',
        }),
    });

    const response = await conductor.chat('hi');
    expect(response.provider).toBe('ollama');
    expect(response.content).toBe('local');
  });

  it('suggests corrections for mistyped provider ids', async () => {
    const conductor = new Conductor({
      providers: [
        { id: 'mistral', apiKey: 'x', model: 'mistral-small-latest' },
        { id: 'gemini', apiKey: 'y', model: 'gemini-flash-latest' },
      ],
      routing: { strategy: 'priority' },
      fetch: async () =>
        jsonResponse({
          choices: [{ message: { content: 'ok' } }],
          model: 'm',
        }),
    });

    await expect(conductor.chat('hi', { provider: 'mistal' })).rejects.toThrow(
      /Unknown provider id "mistal".*Did you mean:.*mistral/i,
    );
  });

  it('rejects known providers that are not in the config', async () => {
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'y', model: 'gemini-flash-latest' }],
      routing: { strategy: 'priority' },
      fetch: async () =>
        jsonResponse({
          choices: [{ message: { content: 'ok' } }],
          model: 'm',
        }),
    });

    await expect(conductor.chat('hi', { provider: 'mistral' })).rejects.toThrow(
      /not in the current config/i,
    );
  });
});
