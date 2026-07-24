import type { ChatOptions, GenerationParams, Message, TokenUsage } from '../types.js';
import { getFixedTemperature, PROVIDERS, resolveBaseUrl, type ProviderId } from './registry.js';

export interface OpenAIChatSuccess {
  content: string;
  model?: string;
  usage?: TokenUsage;
  headers: Record<string, string>;
  status: number;
  raw?: unknown;
}

export interface OpenAIChatError {
  status: number;
  message: string;
  retryAfterSec?: number;
  headers: Record<string, string>;
  rateLimited: boolean;
  retryable: boolean;
}

export type OpenAIChatResult =
  { ok: true; data: OpenAIChatSuccess } | { ok: false; error: OpenAIChatError };

export interface ResolvedProviderEndpoint {
  id: ProviderId;
  model: string;
  apiKey: string;
  baseUrl: string;
  params?: GenerationParams;
}

function flattenHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function parseRetryAfterSeconds(headers: Record<string, string>): number | undefined {
  const raw = headers['retry-after'];
  if (!raw) return undefined;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum >= 0) return asNum;
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  }
  return undefined;
}

function mergeParams(
  provider: ProviderId,
  profileParams: GenerationParams | undefined,
  options?: ChatOptions,
): GenerationParams {
  const fixed = getFixedTemperature(provider);
  return {
    temperature: fixed !== undefined ? fixed : (options?.temperature ?? profileParams?.temperature),
    topP: options?.topP ?? profileParams?.topP,
    maxTokens: options?.maxTokens ?? profileParams?.maxTokens,
    frequencyPenalty: options?.frequencyPenalty ?? profileParams?.frequencyPenalty,
    presencePenalty: options?.presencePenalty ?? profileParams?.presencePenalty,
    stop: options?.stop ?? profileParams?.stop,
  };
}

/**
 * Call an OpenAI-compatible `/chat/completions` endpoint via fetch.
 */
export async function openaiChatCompletion(
  endpoint: ResolvedProviderEndpoint,
  messages: Message[],
  options?: ChatOptions,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<OpenAIChatResult> {
  const meta = PROVIDERS[endpoint.id];
  const baseUrl = resolveBaseUrl(endpoint.id, endpoint.baseUrl);
  const url = `${baseUrl}/chat/completions`;
  const params = mergeParams(endpoint.id, endpoint.params, options);
  const model = options?.model?.trim() || endpoint.model;

  if (!model) {
    return {
      ok: false,
      error: {
        status: 400,
        message: `No model configured for provider "${endpoint.id}".`,
        headers: {},
        rateLimited: false,
        retryable: false,
      },
    };
  }

  if (meta.requiresApiKey && !endpoint.apiKey) {
    return {
      ok: false,
      error: {
        status: 401,
        message: `API key required for provider "${endpoint.id}".`,
        headers: {},
        rateLimited: false,
        retryable: false,
      },
    };
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    ...options?.metadata,
  };
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.topP !== undefined) body.top_p = params.topP;
  if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
  if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty;
  if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty;
  if (params.stop !== undefined) body.stop = params.stop;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${endpoint.apiKey || (endpoint.id === 'ollama' ? 'ollama' : '')}`,
  };

  if (endpoint.id === 'openrouter') {
    headers['http-referer'] = 'https://github.com/XXanderWP/ai-conductor';
    headers['x-title'] = 'AI Conductor';
  }

  const timeoutMs = options?.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const responseHeaders = flattenHeaders(response.headers);
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    if (!response.ok) {
      const errObj = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
      const errMsg =
        (errObj.error &&
          typeof errObj.error === 'object' &&
          typeof (errObj.error as { message?: unknown }).message === 'string' &&
          (errObj.error as { message: string }).message) ||
        (typeof errObj.message === 'string' && errObj.message) ||
        text ||
        response.statusText;

      const rateLimited =
        response.status === 429 || /rate.?limit|resource.?exhausted/i.test(String(errMsg));

      return {
        ok: false,
        error: {
          status: response.status,
          message: String(errMsg),
          retryAfterSec: parseRetryAfterSeconds(responseHeaders),
          headers: responseHeaders,
          rateLimited,
          retryable: rateLimited || response.status >= 500,
        },
      };
    }

    const data = json as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return {
        ok: false,
        error: {
          status: response.status,
          message: 'Provider returned no message content.',
          headers: responseHeaders,
          rateLimited: false,
          retryable: true,
        },
      };
    }

    return {
      ok: true,
      data: {
        content,
        model: data.model ?? model,
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
            }
          : undefined,
        headers: responseHeaders,
        status: response.status,
        raw: json,
      },
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === 'AbortError'
          ? `Request timed out after ${timeoutMs}ms`
          : error.message
        : String(error);
    return {
      ok: false,
      error: {
        status: 0,
        message,
        headers: {},
        rateLimited: false,
        retryable: true,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
