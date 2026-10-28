import type { Message, MessageContentPart } from './types.js';

/**
 * Flatten message content to plain text (image parts become `[image]`).
 */
export function messageText(content: string | MessageContentPart[]): string {
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n');
}

function cloneContent(content: string | MessageContentPart[]): string | MessageContentPart[] {
  if (typeof content === 'string') return content;
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { ...part.image_url } },
  );
}

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
    content: cloneContent(message.content),
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
  return input.map((message) => `${message.role}: ${messageText(message.content)}`).join('\n');
}
