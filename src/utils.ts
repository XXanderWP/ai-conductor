import type { Message } from './types.js';

/**
 * Normalize a string or message list into chat messages.
 */
export function normalizeMessages(input: string | Message[]): Message[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('chat() requires a non-empty string or message array.');
  }
  return input.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

/**
 * Normalize a string or message list into a single prompt string.
 * Useful when wrapping providers that only accept plain text.
 */
export function toPrompt(input: string | Message[]): string {
  if (typeof input === 'string') {
    return input;
  }
  return input.map((message) => `${message.role}: ${message.content}`).join('\n');
}
