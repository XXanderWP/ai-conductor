import type { ChatOptions, Message } from '../types.js';
import type { OpenAIChatResult } from './openai-client.js';
import type { ProviderId } from './registry.js';

/**
 * In-memory provider stub for unit tests (does not implement HTTP).
 * Prefer injecting a custom `fetch` into {@link Conductor} for integration-style tests.
 */
export class MockChatBackend {
  callCount = 0;

  constructor(
    readonly id: ProviderId | string,
    private readonly handler: (
      messages: Message[],
      options?: ChatOptions,
    ) => Promise<OpenAIChatResult> | OpenAIChatResult,
  ) {}

  async complete(messages: Message[], options?: ChatOptions): Promise<OpenAIChatResult> {
    this.callCount += 1;
    return this.handler(messages, options);
  }
}
