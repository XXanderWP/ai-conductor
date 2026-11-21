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
