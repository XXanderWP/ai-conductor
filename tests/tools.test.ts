import {
  assistantMessageFromResponse,
  Conductor,
  isToolCallMessage,
  isToolResultMessage,
  messageText,
  toolResultMessage,
  toPrompt,
  type Message,
  type ToolCall,
  type ToolDefinition,
} from '../src/index';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** SSE response from raw chunk objects. */
function sseChunks(chunks: unknown[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const weatherTool: ToolDefinition = {
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
};

function toolCallResponse(toolCalls: unknown[], extra: Record<string, unknown> = {}) {
  return jsonResponse({
    model: 'gemini-flash-latest',
    choices: [
      {
        message: { role: 'assistant', content: null, tool_calls: toolCalls },
        finish_reason: 'tool_calls',
      },
    ],
    ...extra,
  });
}

function capture() {
  const bodies: Array<Record<string, unknown>> = [];
  const urls: string[] = [];
  return { bodies, urls };
}

describe('tool calling: request building', () => {
  it('sends tools, tool_choice and parallel_tool_calls when tools are passed', async () => {
    const { bodies } = capture();
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
      },
    });

    await conductor.chat('weather?', {
      tools: [weatherTool],
      toolChoice: { type: 'function', function: { name: 'get_weather' } },
      parallelToolCalls: false,
    });

    expect(bodies[0]?.tools).toEqual([weatherTool]);
    expect(bodies[0]?.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
    expect(bodies[0]?.parallel_tool_calls).toBe(false);
  });

  it('keeps the 0.1.5 body byte-identical without tools', async () => {
    const raw: string[] = [];
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: async (_input, init) => {
        raw.push(String(init?.body));
        return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
      },
    });

    await conductor.chat('hi', { temperature: 0.5, toolChoice: 'auto', parallelToolCalls: true });
    await conductor.chat([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);

    expect(raw).toEqual([
      '{"model":"gemini-flash-latest","messages":[{"role":"user","content":"hi"}],"stream":false,"temperature":0.5}',
      '{"model":"gemini-flash-latest","messages":[{"role":"system","content":"sys"},{"role":"user","content":"hi"}],"stream":false}',
    ]);
  });

  it('sends content: null for empty assistant tool-call messages and keeps tool_call_id', async () => {
    const { bodies } = capture();
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ choices: [{ message: { content: 'Sunny.' } }] });
      },
    });

    await conductor.chat([
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Berlin"}' },
            custom_key: 1,
          } as ToolCall,
        ],
      },
      toolResultMessage('c1', { temp: 21 }, 'get_weather'),
    ]);

    const messages = bodies[0]?.messages as Array<Record<string, unknown>>;
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Berlin"}' },
          custom_key: 1,
        },
      ],
    });
    expect(messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: '{"temp":21}',
      name: 'get_weather',
    });
  });
});

describe('tool calling: non-streaming responses', () => {
  it('normalizes tool_calls, returns empty content and finishReason', async () => {
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: async () =>
        toolCallResponse([
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Berlin"}' },
          },
        ]),
    });

    const res = await conductor.chat('weather?', { tools: [weatherTool] });

    expect(res.content).toBe('');
    expect(res.finishReason).toBe('tool_calls');
    expect(res.provider).toBe('gemini');
    expect(res.toolCalls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Berlin"}' },
      },
    ]);
  });

  it('stringifies object arguments and generates missing ids', async () => {
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: async () =>
        toolCallResponse([
          { function: { name: 'get_weather', arguments: { city: 'Paris' } } },
          { function: { name: 'get_weather', arguments: { city: 'Rome' } } },
        ]),
    });

    const res = await conductor.chat('weather?', { tools: [weatherTool] });

    expect(res.toolCalls).toHaveLength(2);
    expect(res.toolCalls?.[0]?.function.arguments).toBe('{"city":"Paris"}');
    expect(res.toolCalls?.[0]?.type).toBe('function');
    expect(res.toolCalls?.[0]?.id).toMatch(/^call_\d+_0$/);
    expect(res.toolCalls?.[1]?.id).toMatch(/^call_\d+_1$/);
  });

  it('does not set toolCalls / finishReason for plain text replies without them', async () => {
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: async () => jsonResponse({ choices: [{ message: { content: 'hello' } }] }),
    });

    const res = await conductor.chat('hi');
    expect(res.content).toBe('hello');
    expect('toolCalls' in res).toBe(false);
    expect('finishReason' in res).toBe(false);
  });

  it('passes extra_content.google.thought_signature through to the next request', async () => {
    const { bodies } = capture();
    let call = 0;
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        call += 1;
        if (call === 1) {
          return toolCallResponse([
            {
              id: 'gc1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Oslo"}' },
              extra_content: { google: { thought_signature: 'sig-123' } },
            },
          ]);
        }
        return jsonResponse({ choices: [{ message: { content: 'Cold.' } }] });
      },
    });

    const history: Message[] = [{ role: 'user', content: 'weather in Oslo?' }];
    const first = await conductor.chat(history, { tools: [weatherTool] });
    expect(first.toolCalls?.[0]?.extra_content).toEqual({
      google: { thought_signature: 'sig-123' },
    });

    const assistant = assistantMessageFromResponse(first);
    expect(isToolCallMessage(assistant)).toBe(true);
    history.push(assistant, toolResultMessage('gc1', 'cold, -5C'));

    const second = await conductor.chat(history, { tools: [weatherTool] });
    expect(second.content).toBe('Cold.');

    const sent = bodies[1]?.messages as Array<{ tool_calls?: ToolCall[] }>;
    expect(sent[1]?.tool_calls?.[0]?.extra_content).toEqual({
      google: { thought_signature: 'sig-123' },
    });
  });
});

describe('tool calling: streaming', () => {
  it('assembles a tool call split across chunks and keeps text in onChunk only', async () => {
    const chunks: string[] = [];
    const calls: ToolCall[] = [];
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: async () =>
        sseChunks([
          { choices: [{ delta: { content: 'Checking' } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 's1',
                      type: 'function',
                      function: { name: 'get_', arguments: '' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { name: 'weather', arguments: '{"ci' } }],
                },
              },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Kyiv"}' } }] } },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, extra_content: { google: { thought_signature: 'abc' } } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, extra_content: { google: { other: 1 } } }],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]),
    });

    const { result } = conductor.chatStream('weather?', (text) => chunks.push(text), {
      tools: [weatherTool],
      onToolCall: (call) => calls.push(call),
    });
    const res = await result;

    expect(chunks).toEqual(['Checking']);
    const expected: ToolCall = {
      id: 's1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Kyiv"}' },
      extra_content: { google: { thought_signature: 'abc', other: 1 } },
    };
    expect(calls).toEqual([expected]);
    expect(res.toolCalls).toEqual([expected]);
    expect(res.content).toBe('Checking');
    expect(res.finishReason).toBe('tool_calls');
  });

  it('assembles two interleaved parallel tool calls by index', async () => {
    const calls: ToolCall[] = [];
    const conductor = new Conductor({
      providers: [{ id: 'openai', apiKey: 'o', model: 'gpt-4o-mini' }],
      fetch: async () =>
        sseChunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'a',
                      type: 'function',
                      function: { name: 'get_weather', arguments: '' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 1,
                      id: 'b',
                      type: 'function',
                      function: { name: 'get_weather', arguments: '{"city":' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"A"}' } }] } },
            ],
          },
          { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"B"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
    });

    const { result } = conductor.chatStream('weather in A and B', () => undefined, {
      tools: [weatherTool],
      onToolCall: (call) => calls.push(call),
    });
    const res = await result;

    expect(res.content).toBe('');
    expect(res.toolCalls?.map((c) => [c.id, c.function.arguments])).toEqual([
      ['a', '{"city":"A"}'],
      ['b', '{"city":"B"}'],
    ]);
    expect(calls).toHaveLength(2);
  });

  it('falls back to JSON parsing when the provider ignores stream: true', async () => {
    const chunks: string[] = [];
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: async () =>
        toolCallResponse([
          { id: 'j1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
        ]),
    });

    const { result } = conductor.chatStream('weather?', (t) => chunks.push(t), {
      tools: [weatherTool],
    });
    const res = await result;

    expect(chunks).toEqual([]);
    expect(res.toolCalls?.[0]?.id).toBe('j1');
    expect(res.finishReason).toBe('tool_calls');
  });

  it('streams text from a plain JSON body when stream is ignored', async () => {
    const chunks: string[] = [];
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: async () => jsonResponse({ choices: [{ message: { content: 'whole' } }] }),
    });

    const res = await conductor.chatStream('hi', (t) => chunks.push(t)).result;
    expect(chunks).toEqual(['whole']);
    expect(res.content).toBe('whole');
  });
});

describe('tool calling: errors', () => {
  const geminiError = [
    {
      error: {
        code: 400,
        message: 'Function call is missing a thought_signature',
        status: 'INVALID_ARGUMENT',
      },
    },
  ];

  it('unwraps Gemini array error bodies (non-streaming)', async () => {
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: async () => jsonResponse(geminiError, 400),
    });

    await expect(conductor.chat('hi')).rejects.toThrow(/missing a thought_signature/);
  });

  it('unwraps Gemini array error bodies (streaming)', async () => {
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: async () => jsonResponse(geminiError, 400),
    });

    await expect(conductor.chatStream('hi', () => undefined).result).rejects.toThrow(
      /missing a thought_signature/,
    );
  });
});

describe('tool calling: routing', () => {
  it('skips providers with supportsTools: false when tools are passed', async () => {
    const { urls } = capture();
    const conductor = new Conductor({
      providers: [
        {
          id: 'gemini',
          apiKey: 'g',
          model: 'gemini-flash-latest',
          priority: 100,
          supportsTools: false,
        },
        { id: 'groq', apiKey: 'q', model: 'llama-3.3-70b-versatile', priority: 90 },
      ],
      routing: { strategy: 'priority' },
      fetch: async (input) => {
        urls.push(String(input));
        return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
      },
    });

    const withTools = await conductor.chat('hi', { tools: [weatherTool] });
    expect(withTools.provider).toBe('groq');

    const withoutTools = await conductor.chat('hi');
    expect(withoutTools.provider).toBe('gemini');

    await expect(
      conductor.chat('hi', { provider: 'gemini', tools: [weatherTool] }),
    ).rejects.toThrow(/does not support tools/);
  });

  it('pins tool history to one provider instead of failing over', async () => {
    const urls: string[] = [];
    const conductor = new Conductor({
      providers: [
        { id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest', priority: 100 },
        { id: 'groq', apiKey: 'q', model: 'llama-3.3-70b-versatile', priority: 90 },
      ],
      routing: { strategy: 'failover' },
      fetch: async (input) => {
        urls.push(String(input));
        return jsonResponse({ error: { message: 'overloaded' } }, 503);
      },
    });

    const history: Message[] = [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'x', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
        ],
      },
      toolResultMessage('x', 'sunny'),
    ];

    await expect(conductor.chat(history)).rejects.toThrow(/All providers failed \(gemini\)/);
    expect(urls).toHaveLength(1);

    urls.length = 0;
    await expect(conductor.chat(history, { allowToolFailover: true })).rejects.toThrow(
      /gemini → groq/,
    );
    expect(urls).toHaveLength(2);
  });

  it('routes follow-up requests to the provider and model that issued the tool calls', async () => {
    const seen: Array<{ url: string; model: unknown }> = [];
    const conductor = new Conductor({
      providers: [
        { id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' },
        { id: 'groq', apiKey: 'q', model: 'llama-3.3-70b-versatile' },
      ],
      routing: { strategy: 'round-robin' },
      fetch: async (input, init) => {
        const body = JSON.parse(String(init?.body)) as { model: unknown; messages: Message[] };
        seen.push({ url: String(input), model: body.model });
        if (body.messages.length === 1) {
          return toolCallResponse([
            { id: 'rr1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
          ]);
        }
        return jsonResponse({ choices: [{ message: { content: 'done' } }] });
      },
    });

    const history: Message[] = [{ role: 'user', content: 'weather?' }];
    const first = await conductor.chat(history, { tools: [weatherTool] });
    history.push(assistantMessageFromResponse(first), toolResultMessage('rr1', 'sunny'));
    const second = await conductor.chat(history, { tools: [weatherTool] });

    expect(second.provider).toBe(first.provider);
    expect(seen[1]?.url).toBe(seen[0]?.url);
    expect(seen[1]?.model).toBe(seen[0]?.model);
  });
});

describe('tool calling: compressContext', () => {
  it('keeps tool call / result pairs together and leaves no orphan tool messages', async () => {
    let transcript = '';
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
        transcript = body.messages[1]?.content ?? '';
        return jsonResponse({ choices: [{ message: { content: 'Summary.' } }] });
      },
    });

    const call = (id: string): Message => ({
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
    });
    const history: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first question' },
      call('t1'),
      toolResultMessage('t1', 'r1'),
      { role: 'assistant', content: 'answer 1' },
      { role: 'user', content: 'second question' },
      call('t2'),
      toolResultMessage('t2', 'r2'),
      { role: 'assistant', content: 'answer 2' },
    ];

    // keepLast: 2 would cut between the tool result and the call; the cut moves to the user turn.
    const result = await conductor.compressContext(history, { keepLast: 2 });

    expect(result.foldedCount).toBe(4);
    expect(result.messages.slice(1)).toEqual(history.slice(5));
    expect(transcript).toContain('assistant: [tool_call get_weather({})]');
    expect(transcript).toContain('tool: [tool_result t1] r1');

    const ids = new Set<string>();
    for (const m of result.messages) {
      if (isToolCallMessage(m)) m.tool_calls.forEach((c) => ids.add(c.id));
      if (isToolResultMessage(m)) expect(ids.has(m.tool_call_id)).toBe(true);
    }
  });

  it('folds nothing when there is no user boundary to cut at', async () => {
    let calls = 0;
    const conductor = new Conductor({
      providers: [{ id: 'gemini', apiKey: 'g', model: 'gemini-flash-latest' }],
      fetch: async () => {
        calls += 1;
        return jsonResponse({ choices: [{ message: { content: 'x' } }] });
      },
    });
    const history: Message[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
      toolResultMessage('a', 'r'),
      { role: 'assistant', content: 'done' },
    ];

    const result = await conductor.compressContext(history, { keepLast: 1 });
    expect(calls).toBe(0);
    expect(result.foldedCount).toBe(0);
    expect(result.messages).toEqual(history);
  });
});

describe('tool calling: text helpers', () => {
  it('renders tool messages and null content without throwing', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }],
      },
      toolResultMessage('a', 'ok'),
    ];

    expect(toPrompt(messages)).toBe(
      'user: hi\nassistant: [tool_call f({"x":1})]\ntool: [tool_result a] ok',
    );
    expect(messageText(null)).toBe('');
    expect(messageText(messages[1]!)).toBe('[tool_call f({"x":1})]');
    expect(messageText('plain')).toBe('plain');
  });

  it('builds tool result and assistant history messages', () => {
    expect(toolResultMessage('id1', 'text')).toEqual({
      role: 'tool',
      tool_call_id: 'id1',
      content: 'text',
    });
    expect(assistantMessageFromResponse({ content: 'hello' })).toEqual({
      role: 'assistant',
      content: 'hello',
    });
  });
});
