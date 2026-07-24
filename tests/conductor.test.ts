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
  it('includes the built-in provider set', () => {
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

  it('lists available and configured providers', async () => {
    const conductor = new Conductor({
      providers: [
        { id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' },
        { id: 'groq', apiKey: 'q', model: 'llama-3.1-8b-instant', enabled: false },
      ],
      fetch: async () => jsonResponse({ choices: [{ message: { content: 'x' } }] }),
    });
    await conductor.whenReady();

    const available = conductor.getAvailableProviders();
    expect(available.map((p) => p.id)).toEqual(
      expect.arrayContaining(['gemini', 'groq', 'ollama']),
    );
    expect(available).toHaveLength(Object.keys(PROVIDERS).length);

    const configured = conductor.getConfiguredProviders();
    expect(configured.map((p) => p.id)).toEqual(['gemini', 'groq']);
  });

  it('parses models from the OpenAI-compatible catalog', async () => {
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          return jsonResponse({
            data: [
              { id: 'models/gemini-2.0.flash', owned_by: 'google' },
              { id: 'gemini-flash-latest', owned_by: 'google' },
            ],
          });
        }
        return jsonResponse({ error: { message: 'unexpected' } }, 500);
      },
    });

    const result = await conductor.listModels('gemini');
    expect(result.ok).toBe(true);
    expect(result.models).toEqual([
      { id: 'gemini-2.0-flash', ownedBy: 'google' },
      { id: 'gemini-flash-latest', ownedBy: 'google' },
    ]);
  });

  it('runs connectivity and real provider tests', async () => {
    const calls: string[] = [];
    const conductor = new Conductor({
      providers: [{ id: 'groq', apiKey: 'q', model: 'llama-3.1-8b-instant' }],
      fetch: async (input, init) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push(`${method} ${url.includes('/chat/completions') ? 'chat' : 'models'}`);

        if (url.includes('/models')) {
          return jsonResponse({
            data: [{ id: 'llama-3.1-8b-instant', owned_by: 'groq' }],
          });
        }

        return jsonResponse({
          choices: [{ message: { content: 'ok' } }],
          model: 'llama-3.1-8b-instant',
        });
      },
    });

    const connectivity = await conductor.testProvider('groq');
    expect(connectivity.ok).toBe(true);
    expect(connectivity.mode).toBe('connectivity');
    expect(connectivity.modelsCount).toBe(1);
    expect(connectivity.checks).toEqual({ apiKeyPresent: true, modelsEndpoint: true });

    const real = await conductor.testProvider('groq', { real: true });
    expect(real.ok).toBe(true);
    expect(real.mode).toBe('real');
    expect(real.preview).toBe('ok');
    expect(real.checks?.chatResponse).toBe(true);
    expect(calls).toEqual(['GET models', 'POST chat']);
  });

  it('fails connectivity tests when the models endpoint rejects the key', async () => {
    const conductor = new Conductor({
      providers: [{ id: 'openai', apiKey: 'bad', model: 'gpt-4o-mini' }],
      fetch: async () => jsonResponse({ error: { message: 'Incorrect API key' } }, 401),
    });

    const result = await conductor.testProvider('openai');
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('connectivity');
    expect(result.error).toMatch(/Incorrect API key/i);
  });

  it('compresses earlier turns into a system summary and keeps the recent tail', async () => {
    let capturedBody: unknown;
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return jsonResponse({
          choices: [
            {
              message: {
                content: 'User asked about shipping and chose express delivery.',
              },
            },
          ],
          model: 'gemini-flash-latest',
        });
      },
    });

    const history = [
      { role: 'system' as const, content: 'You are a helpful shop assistant.' },
      { role: 'user' as const, content: 'I need to ship a package' },
      { role: 'assistant' as const, content: 'Where to?' },
      { role: 'user' as const, content: 'Berlin' },
      { role: 'assistant' as const, content: 'Express or standard?' },
      { role: 'user' as const, content: 'Express please' },
      { role: 'assistant' as const, content: 'Booked express to Berlin.' },
    ];

    const result = await conductor.compressContext(history, { keepLast: 2 });

    expect(result.foldedCount).toBe(4);
    expect(result.summary).toBe('User asked about shipping and chose express delivery.');
    expect(result.provider).toBe('gemini');
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toEqual({
      role: 'system',
      content:
        'You are a helpful shop assistant.\n\nPrior conversation context:\nUser asked about shipping and chose express delivery.',
    });
    expect(result.messages.slice(1)).toEqual([
      { role: 'user', content: 'Express please' },
      { role: 'assistant', content: 'Booked express to Berlin.' },
    ]);

    const body = capturedBody as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[1]?.content).toContain('user: I need to ship a package');
    expect(body.messages[1]?.content).not.toContain('Express please');
  });

  it('returns the original dialog when there is nothing to fold', async () => {
    let calls = 0;
    const conductor = new Conductor({
      providers: [{ id: 'ollama', model: 'llama3.2' }],
      fetch: async () => {
        calls += 1;
        return jsonResponse({ choices: [{ message: { content: 'noop' } }] });
      },
    });

    const history = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hello' },
    ];
    const result = await conductor.compressContext(history, { keepLast: 4 });

    expect(calls).toBe(0);
    expect(result.foldedCount).toBe(0);
    expect(result.summary).toBe('');
    expect(result.messages).toEqual(history);
  });
});
