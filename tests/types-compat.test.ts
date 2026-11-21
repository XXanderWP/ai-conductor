/**
 * Compile-time compatibility checks: 0.1.5-style code must still type-check
 * (ts-jest fails the suite on type errors).
 */
import type { ChatResponse, Message, MessageRole } from '../src/index';

describe('0.1.5 type compatibility', () => {
  it('accepts plain text messages and string content', () => {
    const m: Message = { role: 'user', content: 'hi' };
    const history: Message[] = [
      { role: 'system', content: 'sys' },
      m,
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ];

    const res: ChatResponse = { content: ' ok ', provider: 'gemini', strategy: 'cheapest' };
    const trimmed: string = res.content.trim();

    // @ts-expect-error MessageRole is not widened with 'tool'.
    const role: MessageRole = 'tool';

    expect(history).toHaveLength(3);
    expect(trimmed).toBe('ok');
    expect(role).toBe('tool');
  });
});

describe('0.2 type compatibility', () => {
  it('accepts current-version provider config and chat code', async () => {
    const { Conductor } = await import('../src/index');
    const conductor = new Conductor({
      providers: [
        { id: 'gemini', apiKey: 'k', model: 'gemini-flash-latest', priority: 100 },
        { id: 'groq', enabled: false },
      ],
      routing: { strategy: 'cheapest' },
      fallback: ['gemini', 'groq'],
      fetch: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: ' hi ' } }] }), {
          status: 200,
        }),
    });
    const res = await conductor.chat('hello', { provider: 'gemini', temperature: 0 });
    const text: string = res.content.trim();
    const { result } = conductor.chatStream('hello', (chunk: string) => chunk, {
      chunkMode: 'delta',
    });
    await result.catch(() => undefined);
    expect(text).toBe('hi');
  });
});
