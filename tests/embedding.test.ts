import { jest } from '@jest/globals';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConductorError } from '../src/index';
import {
  Conductor,
  detectOllama,
  isConductorError,
  MemoryUsageStore,
  parseRateLimitHeaders,
  stripThinkBlocks,
  type ConductorResponseEvent,
} from '../src/index';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const ok = (content = 'ok', extra: Record<string, unknown> = {}) =>
  jsonResponse({ choices: [{ message: { content } }], model: 'm', ...extra });

/** SSE response from raw chunk objects; `hang: true` keeps the stream open afterwards. */
function sseChunks(chunks: unknown[], options: { hang?: boolean; comments?: number } = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      if (options.hang) return;
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const textChunk = (content: string) => ({ model: 'm', choices: [{ delta: { content } }] });

async function rejection(promise: Promise<unknown>): Promise<ConductorError> {
  try {
    await promise;
  } catch (error) {
    expect(isConductorError(error)).toBe(true);
    return error as ConductorError;
  }
  throw new Error('expected a rejection');
}

describe('multiple instances of one provider', () => {
  it('uses each instance key, counts usage per instance, returns the instance id', async () => {
    const auth: string[] = [];
    const conductor = new Conductor({
      env: false,
      providers: [
        { id: 'gemini-work', provider: 'gemini', apiKey: 'key-work', model: 'gemini-flash-latest' },
        { id: 'gemini-home', provider: 'gemini', model: 'gemini-flash-latest' },
      ],
      apiKeys: { 'gemini-home': 'key-home' },
      fetch: async (_input, init) => {
        auth.push(String((init?.headers as Record<string, string>).authorization));
        return ok();
      },
    });

    const work = await conductor.chat('hi', { provider: 'gemini-work' });
    const home = await conductor.chat('hi', { provider: 'gemini-home' });
    await conductor.chat('hi', { provider: 'gemini-home' });

    expect(auth).toEqual(['Bearer key-work', 'Bearer key-home', 'Bearer key-home']);
    expect(work.provider).toBe('gemini-work');
    expect(work.providerType).toBe('gemini');
    expect(home.provider).toBe('gemini-home');
    expect(conductor.getDailyUsage('gemini-work')).toBe(1);
    expect(conductor.getDailyUsage('gemini-home')).toBe(2);
    expect(conductor.getDailyUsage('gemini')).toBe(0);
  });

  it('applies fallback order and dailyLimit per instance id', async () => {
    const auth: string[] = [];
    const conductor = new Conductor({
      env: false,
      providers: [
        { id: 'a', provider: 'gemini', apiKey: 'A', model: 'm', dailyLimit: 1 },
        { id: 'b', provider: 'gemini', apiKey: 'B', model: 'm' },
      ],
      routing: { strategy: 'failover' },
      fallback: ['a', 'b'],
      fetch: async (_input, init) => {
        auth.push(String((init?.headers as Record<string, string>).authorization));
        return ok();
      },
    });

    expect((await conductor.chat('1')).provider).toBe('a');
    expect((await conductor.chat('2')).provider).toBe('b');
    expect(auth).toEqual(['Bearer A', 'Bearer B']);
  });

  it('surfaces config errors from whenReady()', async () => {
    const dup = new Conductor({
      providers: [
        { id: 'x', provider: 'gemini' },
        { id: 'x', provider: 'groq' },
      ],
    });
    const dupError = await rejection(dup.whenReady());
    expect(dupError.code).toBe('config');
    expect(dupError.message).toMatch(/Duplicate provider instance id "x"/);

    const badType = new Conductor({
      providers: [{ id: 'x', provider: 'nope' as 'gemini' }],
    });
    await expect(badType.whenReady()).rejects.toThrow(/Invalid provider type/);
  });
});

describe('transport mode (fallback: false)', () => {
  it('calls exactly one instance once and returns a rate_limited ConductorError', async () => {
    let calls = 0;
    const conductor = new Conductor({
      env: false,
      providers: [
        { id: 'gemini', apiKey: 'g', model: 'm' },
        { id: 'groq', apiKey: 'q', model: 'm' },
      ],
      routing: { strategy: 'failover' },
      fallback: ['gemini', 'groq'],
      fetch: async () => {
        calls += 1;
        return jsonResponse({ error: { message: 'slow down' } }, 429, { 'retry-after': '7' });
      },
    });

    const error = await rejection(conductor.chat('hi', { provider: 'gemini', fallback: false }));
    expect(calls).toBe(1);
    expect(error.code).toBe('rate_limited');
    expect(error.status).toBe(429);
    expect(error.retryAfterSec).toBe(7);
    expect(error.provider).toBe('gemini');
    expect(error.message).toBe('slow down');
    expect(error.attempts).toEqual([
      { provider: 'gemini', code: 'rate_limited', status: 429, message: 'slow down' },
    ]);
  });

  it('reports daily_limit for the requested instance instead of skipping it', async () => {
    const conductor = new Conductor({
      env: false,
      providers: [
        { id: 'gemini', apiKey: 'g', model: 'm', dailyLimit: 1 },
        { id: 'groq', apiKey: 'q', model: 'm' },
      ],
      fetch: async () => ok(),
    });

    await conductor.chat('hi', { provider: 'gemini', fallback: false });
    const error = await rejection(conductor.chat('hi', { provider: 'gemini', fallback: false }));
    expect(error.code).toBe('daily_limit');
    expect(error.provider).toBe('gemini');
  });

  it('retries the same provider when retries is set', async () => {
    let calls = 0;
    const conductor = new Conductor({
      env: false,
      providers: [{ id: 'gemini', apiKey: 'g', model: 'm' }],
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? jsonResponse({ error: { message: 'busy' } }, 503, { 'retry-after-ms': '5' })
          : ok('second');
      },
    });

    const res = await conductor.chat('hi', { fallback: false, retries: 1 });
    expect(res.content).toBe('second');
    expect(calls).toBe(2);
  });
});

describe('structured errors', () => {
  const single = (fetchImpl: typeof fetch) =>
    new Conductor({
      env: false,
      providers: [{ id: 'openai', apiKey: 'k', model: 'm' }],
      fetch: fetchImpl,
    });

  it('classifies auth, context overflow, Gemini array bodies and network failures', async () => {
    const auth = await rejection(
      single(async () => jsonResponse({ error: { message: 'Invalid key' } }, 401)).chat('hi'),
    );
    expect(auth.code).toBe('auth');
    expect(auth.status).toBe(401);
    expect(auth.body).toEqual({ error: { message: 'Invalid key' } });

    const overflow = await rejection(
      single(async () =>
        jsonResponse(
          { error: { message: "This model's maximum context length is 8192 tokens." } },
          400,
        ),
      ).chat('hi'),
    );
    expect(overflow.code).toBe('context_overflow');

    const gemini = await rejection(
      single(async () =>
        jsonResponse(
          [
            {
              error: {
                code: 429,
                message: 'Quota exceeded for metric',
                status: 'RESOURCE_EXHAUSTED',
                details: [
                  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '31s' },
                ],
              },
            },
          ],
          429,
        ),
      ).chat('hi'),
    );
    expect(gemini.message).toMatch(/Quota exceeded for metric/);
    expect(gemini.message).not.toMatch(/HTTP 4/);
    expect(gemini.code).toBe('rate_limited');
    expect(gemini.retryAfterSec).toBe(31);

    const network = await rejection(
      single(async () => {
        throw new TypeError('fetch failed');
      }).chat('hi'),
    );
    expect(network.code).toBe('network');
    expect(network.status).toBe(0);
  });

  it('lists every tried instance in attempts', async () => {
    const conductor = new Conductor({
      env: false,
      providers: [
        { id: 'gemini', apiKey: 'g', model: 'm' },
        { id: 'groq', apiKey: 'q', model: 'm' },
        { id: 'mistral', apiKey: 'x', model: 'm' },
      ],
      routing: { strategy: 'failover' },
      fallback: ['gemini', 'groq', 'mistral'],
      fetch: async (input) => {
        const url = String(input);
        if (url.includes('groq')) return jsonResponse({ error: { message: 'bad key' } }, 401);
        return jsonResponse({ error: { message: 'down' } }, 500);
      },
    });

    const error = await rejection(conductor.chat('hi'));
    expect(error.message).toMatch(/All providers failed \(gemini → groq → mistral\)/);
    expect(error.attempts?.map((a) => [a.provider, a.code, a.status])).toEqual([
      ['gemini', 'http', 500],
      ['groq', 'auth', 401],
      ['mistral', 'http', 500],
    ]);
  });

  it('parses rate-limit headers', () => {
    expect(
      parseRateLimitHeaders({
        'X-RateLimit-Remaining-Requests': '0',
        'x-ratelimit-remaining-tokens': '1200',
        'x-ratelimit-reset-requests': '6m0s',
        'x-ratelimit-reset-tokens': '250ms',
        'retry-after': '3',
      }),
    ).toEqual({
      remainingRequests: 0,
      remainingTokens: 1200,
      resetRequestsMs: 360_000,
      resetTokensMs: 250,
      retryAfterSec: 3,
    });
  });
});

describe('headers and usage on success', () => {
  it('returns response headers and usage for chat', async () => {
    const conductor = new Conductor({
      env: false,
      providers: [{ id: 'openrouter', apiKey: 'o', model: 'openrouter/auto' }],
      fetch: async () =>
        jsonResponse(
          {
            choices: [{ message: { content: 'hi' } }],
            model: 'vendor/resolved',
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          },
          200,
          { 'X-Kilo-Resolved-Model': 'vendor/resolved', 'x-ratelimit-remaining-requests': '9' },
        ),
    });

    const res = await conductor.chat('hi');
    expect(res.headers?.['x-kilo-resolved-model']).toBe('vendor/resolved');
    expect(res.headers?.['x-ratelimit-remaining-requests']).toBe('9');
    expect(res.usage).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 });
    expect(res.model).toBe('vendor/resolved');
  });

  it('requests and reads the final usage chunk when streaming', async () => {
    let body: Record<string, unknown> = {};
    const conductor = new Conductor({
      env: false,
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return sseChunks([
          textChunk('Hel'),
          textChunk('lo'),
          {
            model: 'm',
            choices: [],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          },
        ]);
      },
    });

    const res = await conductor.chatStream('hi', () => undefined).result;
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(res.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
    expect(res.headers?.['content-type']).toBe('text/event-stream');
  });

  it('does not send stream_options to providers without supportsStreamUsage', async () => {
    let body: Record<string, unknown> = {};
    const conductor = new Conductor({
      env: false,
      providers: [{ id: 'mistral', apiKey: 'x', model: 'm' }],
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return sseChunks([textChunk('ok')]);
      },
    });
    await conductor.chatStream('hi', () => undefined).result;
    expect('stream_options' in body).toBe(false);
  });
});

/** Fake AbortSignal-compatible object that counts listeners. */
function countingSignal() {
  const controller = new AbortController();
  const signal = controller.signal;
  let active = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((
    type: string,
    listener: EventListener,
    opts?: AddEventListenerOptions,
  ) => {
    active += 1;
    add(type, listener, opts);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((
    type: string,
    listener: EventListener,
    opts?: EventListenerOptions,
  ) => {
    active -= 1;
    remove(type, listener, opts);
  }) as typeof signal.removeEventListener;
  return { controller, signal, active: () => active };
}

describe('external AbortSignal', () => {
  it('aborts a stream with code aborted, no failover and no listener leak', async () => {
    const urls: string[] = [];
    const { controller, signal, active } = countingSignal();
    const conductor = new Conductor({
      env: false,
      providers: [
        { id: 'gemini', apiKey: 'g', model: 'm' },
        { id: 'groq', apiKey: 'q', model: 'm' },
      ],
      routing: { strategy: 'failover' },
      fallback: ['gemini', 'groq'],
      fetch: async (input) => {
        urls.push(String(input));
        return sseChunks([textChunk('partial')], { hang: true });
      },
    });

    const chunks: string[] = [];
    const { result } = conductor.chatStream(
      'hi',
      (t) => {
        chunks.push(t);
        queueMicrotask(() => controller.abort());
      },
      { signal, idleTimeoutMs: 0, totalTimeoutMs: 0 },
    );

    const error = await rejection(result);
    expect(error.code).toBe('aborted');
    expect(urls).toHaveLength(1);
    expect(chunks).toEqual(['partial']);
    expect(active()).toBe(0);
  });

  it('aborts chat before failover and cleans up after success', async () => {
    const { controller, signal, active } = countingSignal();
    let calls = 0;
    const conductor = new Conductor({
      env: false,
      providers: [{ id: 'gemini', apiKey: 'g', model: 'm' }],
      fetch: async () => {
        calls += 1;
        return ok();
      },
    });

    await conductor.chat('hi', { signal });
    expect(active()).toBe(0);

    controller.abort();
    const error = await rejection(conductor.chat('hi', { signal }));
    expect(error.code).toBe('aborted');
    expect(calls).toBe(1);
    expect(active()).toBe(0);
  });
});

describe('stream watchdogs', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects with stalled and partialContent after idleTimeoutMs', async () => {
    jest.useFakeTimers();
    const conductor = new Conductor({
      env: false,
      providers: [{ id: 'gemini', apiKey: 'g', model: 'm' }],
      fetch: async () => sseChunks([textChunk('Hello, wor')], { hang: true }),
    });

    const { result } = conductor.chatStream('hi', () => undefined, { idleTimeoutMs: 1_000 });
    const settled = rejection(result);
    await jest.advanceTimersByTimeAsync(1_500);
    const error = await settled;

    expect(error.code).toBe('stalled');
    expect(error.partialContent).toBe('Hello, wor');
    expect(error.message).toMatch(/no data for 1000ms/);
  });

  it('enforces totalTimeoutMs even while bytes keep arriving', async () => {
    jest.useFakeTimers();
    const encoder = new TextEncoder();
    const conductor = new Conductor({
      env: false,
      providers: [{ id: 'gemini', apiKey: 'g', model: 'm' }],
      fetch: async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const tick = () => {
              try {
                controller.enqueue(encoder.encode(': keep-alive\n\n'));
              } catch {
                return; // stream cancelled by the watchdog
              }
              setTimeout(tick, 100);
            };
            tick();
          },
        });
        return new Response(stream, { status: 200 });
      },
    });

    const { result } = conductor.chatStream('hi', () => undefined, {
      idleTimeoutMs: 500,
      totalTimeoutMs: 2_000,
    });
    const settled = rejection(result);
    await jest.advanceTimersByTimeAsync(2_100);
    const error = await settled;
    expect(error.code).toBe('stalled');
    expect(error.message).toMatch(/total timeout/);
  });
});

describe('env control', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('ignores process.env keys and leaves ${VAR} unexpanded with env: false', async () => {
    process.env.GEMINI_API_KEY = 'from-env';
    process.env.MY_KEY = 'secret';
    const dir = await mkdtemp(path.join(tmpdir(), 'ai-conductor-env-'));
    const configPath = path.join(dir, 'config.yml');
    await writeFile(
      configPath,
      'providers:\n  - id: gemini\n    model: m\n  - id: groq\n    apiKey: ${MY_KEY}\n    model: m\n',
      'utf8',
    );

    const auth: string[] = [];
    const conductor = new Conductor({
      configPath,
      env: false,
      fetch: async (_input, init) => {
        auth.push(String((init?.headers as Record<string, string>).authorization));
        return ok();
      },
    });

    const noKey = await rejection(conductor.chat('hi', { provider: 'gemini', fallback: false }));
    expect(noKey.code).toBe('config');
    expect(noKey.message).toMatch(/API key required/);

    await conductor.chat('hi', { provider: 'groq' });
    expect(auth).toEqual(['Bearer ${MY_KEY}']);
  });

  it('uses an explicit env map instead of process.env', async () => {
    process.env.GEMINI_API_KEY = 'from-process';
    const auth: string[] = [];
    const conductor = new Conductor({
      env: { GEMINI_API_KEY: 'from-map' },
      providers: [{ id: 'gemini', model: 'm' }],
      fetch: async (_input, init) => {
        auth.push(String((init?.headers as Record<string, string>).authorization));
        return ok();
      },
    });
    await conductor.chat('hi');
    expect(auth).toEqual(['Bearer from-map']);
  });
});

describe('reasoning activity', () => {
  it('reports reasoning deltas and activity kinds', async () => {
    const reasoning: string[] = [];
    const activity: string[] = [];
    const chunks: string[] = [];
    const conductor = new Conductor({
      env: false,
      providers: [{ id: 'openrouter', apiKey: 'o', model: 'm' }],
      fetch: async () =>
        sseChunks([
          { choices: [{ delta: { reasoning: 'think ' } }] },
          { choices: [{ delta: { reasoning_content: 'more' } }] },
          textChunk('answer'),
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: 't', function: { name: 'f', arguments: '{}' } }],
                },
              },
            ],
          },
        ]),
    });

    const res = await conductor.chatStream('hi', (t) => chunks.push(t), {
      onReasoning: (t) => reasoning.push(t),
      onActivity: (k) => activity.push(k),
    }).result;

    expect(reasoning).toEqual(['think ', 'more']);
    expect(activity).toEqual(['reasoning', 'reasoning', 'text', 'tool']);
    expect(chunks).toEqual(['answer']);
    expect(res.reasoning).toBe('think more');
  });

  it('hides an unclosed <think> block while streaming with stripThinking', async () => {
    const chunks: string[] = [];
    const reasoning: string[] = [];
    const conductor = new Conductor({
      env: false,
      providers: [{ id: 'ollama', model: 'qwen3' }],
      fetch: async () =>
        sseChunks([
          textChunk('<thi'),
          textChunk('nk>plan'),
          textChunk(' step'),
          textChunk('</think>Hi'),
          textChunk('!'),
        ]),
    });

    const seen: string[] = [];
    const res = await conductor.chatStream(
      'hi',
      (t) => {
        chunks.push(t);
        seen.push(chunks.join(''));
      },
      { stripThinking: true, onReasoning: (t) => reasoning.push(t) },
    ).result;

    expect(chunks.join('')).toBe('Hi!');
    expect(seen.every((s) => !s.includes('plan') && !s.includes('<'))).toBe(true);
    expect(reasoning.join('')).toBe('plan step');
    expect(res.content).toBe('Hi!');
    expect(res.reasoning).toBe('plan step');

    expect(stripThinkBlocks('<think>never closed')).toEqual({ text: '', thinking: 'never closed' });
  });

  it('strips <think> from non-streaming content', async () => {
    const conductor = new Conductor({
      env: false,
      providers: [{ id: 'ollama', model: 'qwen3' }],
      fetch: async () => ok('<think>hmm</think>Answer'),
    });
    const res = await conductor.chat('hi', { stripThinking: true });
    expect(res.content).toBe('Answer');
    expect(res.reasoning).toBe('hmm');
    expect((await conductor.chat('hi')).content).toBe('<think>hmm</think>Answer');
  });
});

describe('custom headers, body and anonymous gateways', () => {
  it('merges config and request headers over built-in defaults', async () => {
    let headers: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    const conductor = new Conductor({
      env: false,
      providers: [
        {
          id: 'openrouter',
          apiKey: 'o',
          model: 'm',
          headers: { 'HTTP-Referer': 'https://host.app', 'X-Profile': 'config' },
        },
      ],
      fetch: async (_input, init) => {
        headers = init?.headers as Record<string, string>;
        body = JSON.parse(String(init?.body));
        return ok();
      },
    });

    await conductor.chat('hi', {
      headers: { 'x-profile': 'request', 'X-Trace': '1' },
      extraBody: { provider: { order: ['x'] }, model: 'override' },
    });

    expect(headers['http-referer']).toBe('https://host.app');
    expect(headers['x-title']).toBe('AI Conductor');
    expect(headers['x-profile']).toBe('request');
    expect(headers['x-trace']).toBe('1');
    expect(body.provider).toEqual({ order: ['x'] });
    expect(body.model).toBe('override');
  });

  it('sends no Authorization header to an anonymous openai_compatible gateway', async () => {
    let headers: Record<string, string> = {};
    const conductor = new Conductor({
      env: false,
      providers: [{ id: 'openai_compatible', baseUrl: 'http://localhost:8080/v1', model: 'local' }],
      fetch: async (input, init) => {
        expect(String(input)).toBe('http://localhost:8080/v1/chat/completions');
        headers = init?.headers as Record<string, string>;
        return ok();
      },
    });

    await conductor.chat('hi');
    expect('authorization' in headers).toBe(false);
  });
});

describe('reasoningEffort', () => {
  it('is sent to Gemini and dropped for providers without support', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const conductor = new Conductor({
      env: false,
      providers: [
        { id: 'gemini', apiKey: 'g', model: 'm' },
        { id: 'mistral', apiKey: 'x', model: 'm' },
      ],
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return ok();
      },
    });

    await conductor.chat('hi', { provider: 'gemini', reasoningEffort: 'low' });
    await conductor.chat('hi', { provider: 'mistral', reasoningEffort: 'low' });
    expect(bodies[0]?.reasoning_effort).toBe('low');
    expect('reasoning_effort' in (bodies[1] ?? {})).toBe(false);
  });
});

describe('onResponse and usageStore', () => {
  it('reports success and failure attempts', async () => {
    const events: ConductorResponseEvent[] = [];
    const conductor = new Conductor({
      env: false,
      providers: [
        { id: 'g1', provider: 'gemini', apiKey: 'g', model: 'gm' },
        { id: 'q1', provider: 'groq', apiKey: 'q', model: 'qm' },
      ],
      routing: { strategy: 'failover' },
      fallback: ['g1', 'q1'],
      onResponse: (event) => events.push(event),
      fetch: async (input) =>
        String(input).includes('generativelanguage')
          ? jsonResponse({ error: { message: 'quota' } }, 429, { 'retry-after': '2' })
          : jsonResponse({
              choices: [{ message: { content: 'ok' } }],
              model: 'qm',
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
    });

    await conductor.chat('hi');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      provider: 'g1',
      providerType: 'gemini',
      model: 'gm',
      status: 429,
      ok: false,
    });
    expect(events[0]?.error?.code).toBe('rate_limited');
    expect(events[0]?.headers['retry-after']).toBe('2');
    expect(events[1]).toMatchObject({
      provider: 'q1',
      providerType: 'groq',
      model: 'qm',
      status: 200,
      ok: true,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    expect(typeof events[1]?.durationMs).toBe('number');
  });

  it('persists counters through a custom usageStore', async () => {
    const store = new MemoryUsageStore();
    const make = () =>
      new Conductor({
        env: false,
        usageStore: store,
        providers: [{ id: 'gemini', apiKey: 'g', model: 'm', dailyLimit: 1 }],
        fetch: async () => ok(),
      });

    await make().chat('hi');
    const restarted = make();
    expect(restarted.getDailyUsage('gemini')).toBe(1);
    expect((await rejection(restarted.chat('hi'))).code).toBe('no_provider');
  });
});

describe('updateConfig', () => {
  it('keeps counters of surviving instances and drops removed ones', async () => {
    const conductor = new Conductor({
      env: false,
      providers: [
        { id: 'a', provider: 'gemini', apiKey: 'A', model: 'm' },
        { id: 'b', provider: 'groq', apiKey: 'B', model: 'm' },
      ],
      fetch: async () => ok(),
    });

    await conductor.chat('hi', { provider: 'a' });
    await conductor.chat('hi', { provider: 'b' });

    await conductor.updateConfig({
      providers: [
        { id: 'a', provider: 'gemini', apiKey: 'A2', model: 'm' },
        { id: 'c', provider: 'mistral', apiKey: 'C', model: 'm' },
      ],
      routing: { strategy: 'priority' },
    });

    expect(conductor.getDailyUsage('a')).toBe(1);
    expect(conductor.getDailyUsage('b')).toBe(0);
    expect(conductor.getConfiguredProviders().map((p) => p.id)).toEqual(['a', 'c']);
    expect(conductor.getStrategy()).toBe('priority');
    await expect(conductor.chat('hi', { provider: 'b' })).rejects.toThrow(
      /not in the current config|Unknown/,
    );
  });

  it('lets in-flight requests finish with their original config', async () => {
    let release: () => void = () => undefined;
    const auth: string[] = [];
    const conductor = new Conductor({
      env: false,
      providers: [{ id: 'a', provider: 'gemini', apiKey: 'old', model: 'm' }],
      fetch: async (_input, init) => {
        auth.push(String((init?.headers as Record<string, string>).authorization));
        await new Promise<void>((resolve) => (release = resolve));
        return ok();
      },
    });

    const pending = conductor.chat('hi');
    await new Promise((r) => setTimeout(r, 0));
    await conductor.updateConfig({
      providers: [{ id: 'a', provider: 'gemini', apiKey: 'new', model: 'm' }],
    });
    release();
    const res = await pending;
    expect(res.provider).toBe('a');
    expect(auth).toEqual(['Bearer old']);
  });
});

describe('model catalog', () => {
  it('maps context_length, supported_parameters and pricing', async () => {
    const conductor = new Conductor({
      env: false,
      providers: [{ id: 'openrouter', apiKey: 'o', model: 'm' }],
      fetch: async () =>
        jsonResponse({
          data: [
            {
              id: 'vendor/tooly',
              context_length: 131072,
              supported_parameters: ['tools', 'tool_choice', 'temperature'],
              pricing: { prompt: '0', completion: '0' },
            },
            {
              id: 'vendor/plain',
              top_provider: { context_length: 8192 },
              supported_parameters: ['temperature'],
              pricing: { prompt: '0.000001', completion: '0.000002' },
            },
          ],
        }),
    });

    const listed = await conductor.listModels('openrouter');
    expect(listed.models.map((m) => [m.id, m.contextLength, m.supportsTools, m.isFree])).toEqual([
      ['vendor/tooly', 131072, true, true],
      ['vendor/plain', 8192, false, false],
    ]);
    expect(listed.models[0]?.raw).toBeUndefined();

    const detailed = await conductor.listModels('openrouter', { details: true });
    expect(detailed.models[0]?.raw).toMatchObject({ id: 'vendor/tooly' });
  });

  it('detects a local Ollama server', async () => {
    const result = await detectOllama('http://127.0.0.1:11434/v1', {
      timeoutMs: 500,
      fetch: async (input) => {
        expect(String(input)).toBe('http://127.0.0.1:11434/api/tags');
        return jsonResponse({ models: [{ name: 'llama3.2' }] });
      },
    });
    expect(result).toMatchObject({ ok: true, baseUrl: 'http://127.0.0.1:11434/v1' });
    expect(result.models?.map((m) => m.id)).toEqual(['llama3.2']);

    const down = await detectOllama(undefined, {
      fetch: async () => {
        throw new TypeError('connect ECONNREFUSED');
      },
    });
    expect(down.ok).toBe(false);
  });
});
