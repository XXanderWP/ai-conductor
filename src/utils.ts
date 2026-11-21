import type {
  AssistantToolCallMessage,
  ChatResponse,
  Message,
  MessageContentPart,
  TextMessage,
  ToolCall,
  ToolResultMessage,
} from './types.js';

/** Whether a message is an assistant turn that requested tool calls. */
export function isToolCallMessage(message: Message): message is AssistantToolCallMessage {
  return (
    message.role === 'assistant' &&
    Array.isArray((message as Partial<AssistantToolCallMessage>).tool_calls)
  );
}

/** Whether a message is a tool result (`role: 'tool'`). */
export function isToolResultMessage(message: Message): message is ToolResultMessage {
  return message.role === 'tool';
}

function isMessage(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'role' in value;
}

function contentText(content: string | MessageContentPart[] | null | undefined): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n');
}

/**
 * Flatten message content (or a whole message) to plain text.
 * Image parts become `[image]`, tool calls `[tool_call name(args)]`,
 * tool results `[tool_result id] content`. `null` content yields `''`.
 */
export function messageText(
  input: string | MessageContentPart[] | Message | null | undefined,
): string {
  if (!isMessage(input)) return contentText(input);
  if (isToolResultMessage(input)) {
    return `[tool_result ${input.tool_call_id}] ${contentText(input.content)}`;
  }
  if (isToolCallMessage(input)) {
    const calls = input.tool_calls.map(
      (call) => `[tool_call ${call.function?.name ?? ''}(${call.function?.arguments ?? ''})]`,
    );
    const text = contentText(input.content);
    return (text ? [text, ...calls] : calls).join('\n');
  }
  return contentText(input.content);
}

function cloneContent(content: string | MessageContentPart[]): string | MessageContentPart[] {
  if (typeof content === 'string') return content;
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { ...part.image_url } },
  );
}

/** Deep-copy tool calls, keeping unknown keys (e.g. `extra_content`) intact. */
function cloneToolCalls(calls: ToolCall[]): ToolCall[] {
  return calls.map((call) => structuredClone(call));
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
  return input.map((message): Message => {
    if (isToolResultMessage(message)) {
      const out: ToolResultMessage = {
        role: 'tool',
        tool_call_id: message.tool_call_id,
        content: message.content,
      };
      if (message.name !== undefined) out.name = message.name;
      return out;
    }
    if (isToolCallMessage(message)) {
      return {
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: cloneToolCalls(message.tool_calls),
      };
    }
    return {
      role: message.role,
      content: cloneContent(message.content),
    };
  });
}

/** Whether a message list contains tool calls or tool results. */
export function hasToolMessages(messages: Message[]): boolean {
  return messages.some((m) => isToolCallMessage(m) || isToolResultMessage(m));
}

/**
 * Build a tool result message for {@link ToolCall.id}. Objects are `JSON.stringify`-ed.
 */
export function toolResultMessage(
  callId: string,
  content: string | object,
  name?: string,
): ToolResultMessage {
  const out: ToolResultMessage = {
    role: 'tool',
    tool_call_id: callId,
    content: typeof content === 'string' ? content : JSON.stringify(content),
  };
  if (name !== undefined) out.name = name;
  return out;
}

/**
 * Assistant message to push into history after a response: an
 * {@link AssistantToolCallMessage} (with `extra_content` kept) when the model requested tools,
 * otherwise a plain text message.
 */
export function assistantMessageFromResponse(
  response: Pick<ChatResponse, 'content' | 'toolCalls'>,
): AssistantToolCallMessage | TextMessage {
  if (response.toolCalls?.length) {
    return {
      role: 'assistant',
      content: response.content || null,
      tool_calls: cloneToolCalls(response.toolCalls),
    };
  }
  return { role: 'assistant', content: response.content };
}

/**
 * Normalize a string or message list into a single prompt string.
 * Useful when wrapping providers that only accept plain text.
 */
export function toPrompt(input: string | Message[]): string {
  if (typeof input === 'string') {
    return input;
  }
  return input.map((message) => `${message.role}: ${messageText(message)}`).join('\n');
}
