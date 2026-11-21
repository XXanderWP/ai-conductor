/**
 * Structured errors thrown by {@link Conductor}.
 */

import type { ProviderId } from './providers/registry.js';

/** Error kind for branching in host apps. */
export type ConductorErrorCode =
  | 'http'
  | 'rate_limited'
  | 'context_overflow'
  | 'aborted'
  | 'stalled'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'daily_limit'
  | 'config'
  | 'no_provider';

/** One failed attempt in a failover chain. */
export interface ConductorErrorAttempt {
  /** Provider instance id. */
  provider: string;
  code: ConductorErrorCode;
  status?: number;
  message: string;
}

/** Fields of a {@link ConductorError}. */
export interface ConductorErrorInit {
  code: ConductorErrorCode;
  status?: number;
  provider?: string;
  providerType?: ProviderId;
  model?: string;
  retryAfterSec?: number;
  headers?: Record<string, string>;
  body?: unknown;
  partialContent?: string;
  attempts?: ConductorErrorAttempt[];
  cause?: unknown;
}

/** Error with a machine-readable {@link ConductorErrorCode} and provider context. */
export class ConductorError extends Error {
  readonly code: ConductorErrorCode;
  /** HTTP status (`0` for network errors). */
  readonly status?: number;
  /** Provider instance id. */
  readonly provider?: string;
  readonly providerType?: ProviderId;
  readonly model?: string;
  readonly retryAfterSec?: number;
  /** Lower-cased response headers. */
  readonly headers?: Record<string, string>;
  /** Parsed provider error body. */
  readonly body?: unknown;
  /** Text streamed before the failure. */
  readonly partialContent?: string;
  /** Failover chain (every tried instance). */
  readonly attempts?: ConductorErrorAttempt[];

  constructor(message: string, init: ConductorErrorInit) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'ConductorError';
    this.code = init.code;
    if (init.status !== undefined) this.status = init.status;
    if (init.provider !== undefined) this.provider = init.provider;
    if (init.providerType !== undefined) this.providerType = init.providerType;
    if (init.model !== undefined) this.model = init.model;
    if (init.retryAfterSec !== undefined) this.retryAfterSec = init.retryAfterSec;
    if (init.headers !== undefined) this.headers = init.headers;
    if (init.body !== undefined) this.body = init.body;
    if (init.partialContent !== undefined) this.partialContent = init.partialContent;
    if (init.attempts !== undefined) this.attempts = init.attempts;
  }
}

/** Type guard for {@link ConductorError}. */
export function isConductorError(error: unknown): error is ConductorError {
  return error instanceof ConductorError;
}

const RATE_LIMIT_PATTERN = /rate.?limit|resource.?exhausted|quota/i;
const CONTEXT_OVERFLOW_PATTERN =
  /context.?(length|window|size)|too many tokens|maximum context|token limit|prompt is too long|input is too long|reduce the length/i;

/** Classify an HTTP error response. */
export function classifyHttpError(status: number, message: string): ConductorErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429 || RATE_LIMIT_PATTERN.test(message)) return 'rate_limited';
  if (
    (status === 400 || status === 413 || status === 422) &&
    CONTEXT_OVERFLOW_PATTERN.test(message)
  ) {
    return 'context_overflow';
  }
  return 'http';
}
