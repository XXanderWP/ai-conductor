/**
 * Rate-limit header / body hint parsing.
 */

/** Parsed rate-limit state from response headers. */
export interface RateLimitInfo {
  remainingRequests?: number;
  remainingTokens?: number;
  /** Milliseconds until the request quota resets. */
  resetRequestsMs?: number;
  /** Milliseconds until the token quota resets. */
  resetTokensMs?: number;
  /** Seconds to wait before retrying (`retry-after` / `retry-after-ms`). */
  retryAfterSec?: number;
}

const DURATION_PART = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;

/**
 * Parse a duration like `20ms`, `1.5s`, `6m0s`, `1h2m` or a bare number of seconds into ms.
 */
export function parseDurationMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);

  let total = 0;
  let matched = '';
  for (const match of value.matchAll(DURATION_PART)) {
    matched += match[0];
    const n = Number(match[1]);
    const unit = match[2];
    total +=
      unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n * 3_600_000;
  }
  return matched === value ? Math.round(total) : undefined;
}

function parseRetryAfter(headers: Record<string, string>): number | undefined {
  const ms = headers['retry-after-ms'];
  if (ms !== undefined && Number.isFinite(Number(ms))) {
    return Math.max(0, Number(ms) / 1000);
  }
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

function readNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse OpenAI-style rate-limit headers (`x-ratelimit-*`, `retry-after`, `retry-after-ms`).
 * Header names are matched case-insensitively.
 */
export function parseRateLimitHeaders(
  headers: Record<string, string> | Headers | undefined,
): RateLimitInfo {
  const h: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      h[key.toLowerCase()] = value;
    });
  } else if (headers) {
    for (const [key, value] of Object.entries(headers)) h[key.toLowerCase()] = value;
  }

  const out: RateLimitInfo = {};
  const remainingRequests = readNumber(h['x-ratelimit-remaining-requests']);
  const remainingTokens = readNumber(h['x-ratelimit-remaining-tokens']);
  const resetRequestsMs = parseDurationMs(h['x-ratelimit-reset-requests']);
  const resetTokensMs = parseDurationMs(h['x-ratelimit-reset-tokens']);
  const retryAfterSec = parseRetryAfter(h);
  if (remainingRequests !== undefined) out.remainingRequests = remainingRequests;
  if (remainingTokens !== undefined) out.remainingTokens = remainingTokens;
  if (resetRequestsMs !== undefined) out.resetRequestsMs = resetRequestsMs;
  if (resetTokensMs !== undefined) out.resetTokensMs = resetTokensMs;
  if (retryAfterSec !== undefined) out.retryAfterSec = retryAfterSec;
  return out;
}

/** Retry hint from a provider error body (Gemini `RetryInfo.retryDelay`, "retry in 12s"). */
function retryAfterFromBody(body: unknown, message: string): number | undefined {
  const payload = Array.isArray(body) ? body[0] : body;
  const error =
    payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : undefined;
  const details =
    error && typeof error === 'object' ? (error as { details?: unknown }).details : undefined;
  if (Array.isArray(details)) {
    for (const detail of details) {
      const delay =
        detail && typeof detail === 'object'
          ? (detail as { retryDelay?: unknown }).retryDelay
          : undefined;
      if (typeof delay === 'string') {
        const ms = parseDurationMs(delay);
        if (ms !== undefined) return ms / 1000;
      }
    }
  }
  const match = /retry (?:in|after) (\d+(?:\.\d+)?)\s*(ms|s|seconds?)?/i.exec(message);
  if (match) {
    const n = Number(match[1]);
    return match[2]?.toLowerCase() === 'ms' ? n / 1000 : n;
  }
  return undefined;
}

/**
 * Seconds to wait before retrying: `retry-after` / `retry-after-ms`, then
 * `x-ratelimit-reset-*` (only when that quota is exhausted), then error body hints.
 */
export function retryAfterSeconds(
  headers: Record<string, string>,
  body?: unknown,
  message = '',
): number | undefined {
  const info = parseRateLimitHeaders(headers);
  if (info.retryAfterSec !== undefined) return info.retryAfterSec;

  const resets: number[] = [];
  if (info.resetRequestsMs !== undefined && info.remainingRequests === 0) {
    resets.push(info.resetRequestsMs);
  }
  if (info.resetTokensMs !== undefined && info.remainingTokens === 0) {
    resets.push(info.resetTokensMs);
  }
  if (resets.length) return Math.max(...resets) / 1000;

  return retryAfterFromBody(body, message);
}
