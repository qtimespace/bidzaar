/**
 * Mock transport.
 *
 * Stands in for the HTTP layer: simulated latency, correlation ids, and the
 * Problem Details envelope from `docs/00-canonical-model.md` §7. Real service
 * clients would replace this module and nothing above it would change — that
 * separation is the point of keeping it here rather than inlining mocks into
 * components.
 */

import { ApiError, ERROR_CATALOG, type ErrorCode, type ProblemDetails } from '@/domain/errors'
import { getScenario } from './scenarios'

const PROBLEM_BASE = 'https://api.wallet.internal/problems'

/** Canonical §10.6 — SLOW_NETWORK adds a flat 2.5 s to every call. */
const SLOW_NETWORK_DELAY_MS = 2500

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * ULID. Chosen over UUIDv4 for order ids because it sorts lexicographically by
 * creation time — an operator scanning a list of order ids gets chronology for
 * free. Cost: 26 chars instead of 36, and the timestamp is not opaque.
 */
export function ulid(now: number = Date.now()): string {
  let time = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let random = ''
  for (let i = 0; i < 16; i++) random += CROCKFORD[bytes[i] % 32]
  return time + random
}

export function uuidv4(): string {
  return crypto.randomUUID()
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function newCorrelationId(): string {
  return ulid()
}

export function delay(ms: number): Promise<void> {
  const extra = getScenario() === 'SLOW_NETWORK' ? SLOW_NETWORK_DELAY_MS : 0
  return new Promise((resolve) => setTimeout(resolve, ms + extra))
}

function kebab(code: ErrorCode): string {
  return code.toLowerCase().replace(/_/g, '-')
}

export function buildProblem(
  code: ErrorCode,
  detail: string,
  options: { instance?: string; params?: Record<string, string>; correlationId?: string } = {},
): ProblemDetails {
  const meta = ERROR_CATALOG[code]
  return {
    type: `${PROBLEM_BASE}/${kebab(code)}`,
    title: code
      .toLowerCase()
      .split('_')
      .map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w))
      .join(' '),
    status: meta.status,
    code,
    detail,
    instance: options.instance ?? '/v1/exchange-orders',
    correlationId: options.correlationId ?? newCorrelationId(),
    timestamp: nowIso(),
    params: options.params,
    retryable: meta.retryable,
  }
}

/** Throws the catalogued error. Never returns. */
export function fail(
  code: ErrorCode,
  detail: string,
  options: { instance?: string; params?: Record<string, string>; correlationId?: string } = {},
): never {
  throw new ApiError(buildProblem(code, detail, options))
}
