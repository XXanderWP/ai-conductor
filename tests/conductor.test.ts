import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Conductor, isLikelyVisionModel, normalizeConfig, PROVIDERS } from '../src/index';
import { scoreCheapest } from '../src/routing/order';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function sseResponse(deltas: string[], model = 'gemini-flash-latest') {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const delta of deltas) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              model,
              choices: [{ delta: { content: delta } }],
            })}\n\n`,
          ),
        );
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
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
      { id: 'gemini-2.0-flash', ownedBy: 'google', supportsVision: true },
      { id: 'gemini-flash-latest', ownedBy: 'google', supportsVision: true },
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

  it('streams chat deltas and resolves the final response', async () => {
    const chunks: string[] = [];
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { stream?: boolean };
        expect(body.stream).toBe(true);
        return sseResponse(['Пр', 'и', 'вет']);
      },
    });

    const { result } = conductor.chatStream('hi', (text) => chunks.push(text));
    const response = await result;

    expect(chunks).toEqual(['Пр', 'и', 'вет']);
    expect(response.content).toBe('Привет');
    expect(response.provider).toBe('gemini');
  });

  it('can deliver cumulative text to the stream callback', async () => {
    const chunks: string[] = [];
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: async () => sseResponse(['Пр', 'и', 'вет']),
    });

    const { result } = conductor.chatStream('hi', (text) => chunks.push(text), {
      chunkMode: 'cumulative',
    });
    await result;

    expect(chunks).toEqual(['Пр', 'При', 'Привет']);
  });

  it('fails over before the first stream chunk, then streams from the next provider', async () => {
    const chunks: string[] = [];
    const conductor = new Conductor({
      providers: [
        { id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest', priority: 100 },
        { id: 'groq', apiKey: 'q', model: 'llama-3.1-8b-instant', priority: 90 },
      ],
      routing: { strategy: 'failover' },
      fallback: ['gemini', 'groq'],
      fetch: async (input) => {
        if (String(input).includes('generativelanguage')) {
          return jsonResponse({ error: { message: 'quota' } }, 429);
        }
        return sseResponse(['ok']);
      },
    });

    const { result } = conductor.chatStream('hi', (text) => chunks.push(text));
    const response = await result;

    expect(chunks).toEqual(['ok']);
    expect(response.provider).toBe('groq');
    expect(response.failedProviders).toEqual(['gemini']);
  });

  it('cancels an in-flight stream via the returned handle', async () => {
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: async (_input, init) => {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          const onAbort = () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          };
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
    });

    const { result, cancel } = conductor.chatStream('hi', () => undefined);
    queueMicrotask(() => cancel());

    await expect(result).rejects.toThrow(/cancelled/i);
  });
});

describe('vision', () => {
  function capturingFetch(content = 'a cat') {
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      bodies.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return jsonResponse({ choices: [{ message: { content } }], model: 'm' });
    };
    return { bodies, fetchImpl };
  }

  it('exposes vision support per provider in the registry', () => {
    expect(PROVIDERS.cerebras.supportsVision).toBe(false);
    expect(PROVIDERS.gemini.supportsVision).toBe(true);
    expect(isLikelyVisionModel('gemini', 'gemini-flash-latest')).toBe(true);
    expect(isLikelyVisionModel('gemini', 'text-embedding-004')).toBe(false);
    expect(isLikelyVisionModel('groq', 'llama-3.1-8b-instant')).toBe(false);
    expect(isLikelyVisionModel('ollama', 'qwen2.5vl:7b')).toBe(true);
    expect(isLikelyVisionModel('cerebras', 'llama-4-scout')).toBe(false);
  });

  it('reports vision capabilities for configured providers', async () => {
    const conductor = new Conductor({
      providers: [
        { id: 'groq', apiKey: 'q', model: 'llama-3.1-8b-instant' },
        { id: 'cerebras', apiKey: 'c', model: 'llama-3.3-70b' },
      ],
    });
    await conductor.whenReady();

    const caps = conductor.getVisionCapabilities({ configuredOnly: true });
    expect(caps.map((c) => c.provider)).toEqual(['groq', 'cerebras']);
    expect(caps[0]).toMatchObject({
      supportsVision: true,
      configured: true,
      modelSupportsVision: false,
      recognitionModel: PROVIDERS.groq.visionModels?.[0],
    });
    expect(caps[1]).toMatchObject({ supportsVision: false, recognitionModel: undefined });
    expect(conductor.getVisionCapabilities().length).toBe(Object.keys(PROVIDERS).length);
    expect(conductor.supportsVision('cerebras')).toBe(false);
    expect(conductor.supportsVision('openai', 'gpt-4o-mini')).toBe(true);
  });

  it('sends image_url parts and skips providers without vision', async () => {
    const { bodies, fetchImpl } = capturingFetch();
    const conductor = new Conductor({
      providers: [
        { id: 'cerebras', apiKey: 'c', model: 'llama-3.3-70b', priority: 100 },
        { id: 'groq', apiKey: 'q', model: 'llama-3.1-8b-instant', priority: 90 },
      ],
      routing: { strategy: 'priority' },
      fetch: fetchImpl,
    });

    const response = await conductor.recognizeImage('https://example.com/cat.png', {
      prompt: 'What is this?',
      detail: 'low',
    });

    expect(response.provider).toBe('groq');
    expect(response.content).toBe('a cat');
    expect(bodies).toHaveLength(1);
    expect(bodies[0].body.model).toBe(PROVIDERS.groq.visionModels?.[0]);
    expect(bodies[0].body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: 'https://example.com/cat.png', detail: 'low' } },
        ],
      },
    ]);
  });

  it('inlines bytes and local files as data URLs', async () => {
    const { bodies, fetchImpl } = capturingFetch();
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: fetchImpl,
    });
    const dir = await mkdtemp(path.join(tmpdir(), 'ai-conductor-vision-'));
    const filePath = path.join(dir, 'pixel.png');
    await writeFile(filePath, Buffer.from([1, 2, 3]));

    await conductor.recognizeImage([
      { data: new Uint8Array([4, 5, 6]), mimeType: 'image/jpeg' },
      filePath,
    ]);

    const parts = (bodies[0].body.messages as Array<{ content: unknown[] }>)[0].content;
    expect(bodies[0].body.model).toBe('gemini-flash-latest');
    expect(parts.slice(1)).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BAUG' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    ]);
  });

  it('rejects forcing a provider without vision support', async () => {
    const conductor = new Conductor({
      providers: [{ id: 'cerebras', apiKey: 'c', model: 'llama-3.3-70b' }],
      fetch: capturingFetch().fetchImpl,
    });

    await expect(
      conductor.recognizeImage('https://example.com/a.png', { provider: 'cerebras' }),
    ).rejects.toThrow(/does not support image inputs/);
    await expect(conductor.recognizeImage('https://example.com/a.png')).rejects.toThrow(
      /No vision-capable providers/,
    );
  });

  it('filters listed models by catalog modalities', async () => {
    const conductor = new Conductor({
      providers: [{ id: 'openrouter', apiKey: 'o', model: 'openrouter/free' }],
      fetch: async () =>
        jsonResponse({
          data: [
            { id: 'vendor/text-model', architecture: { input_modalities: ['text'] } },
            { id: 'vendor/eyes', architecture: { input_modalities: ['text', 'image'] } },
          ],
        }),
    });

    const listed = await conductor.listVisionModels('openrouter');
    expect(listed.ok).toBe(true);
    expect(listed.models).toEqual([
      { id: 'vendor/eyes', inputModalities: ['text', 'image'], supportsVision: true },
    ]);
  });
});
