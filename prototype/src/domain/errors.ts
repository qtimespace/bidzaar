/**
 * Business error catalog.
 *
 * Mirrors `docs/00-canonical-model.md` §7 one-to-one. `code` is the stable
 * machine-readable contract — the UI branches on it and never on `title`/`detail`.
 *
 * Adding a code here without adding it to the canonical model (and to the OpenAPI
 * spec) is a defect: the three must stay in sync.
 */

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'ASSET_NOT_SUPPORTED',
  'SAME_ASSET_PAIR',
  'PAIR_NOT_SUPPORTED',
  'AMOUNT_BELOW_MINIMUM',
  'AMOUNT_ABOVE_MAXIMUM',
  'INSUFFICIENT_FUNDS',
  'QUOTE_NOT_FOUND',
  'QUOTE_EXPIRED',
  'QUOTE_ALREADY_USED',
  'QUOTE_MISMATCH',
  'RATE_CHANGED',
  'KYC_REQUIRED',
  'KYC_LEVEL_INSUFFICIENT',
  'KYC_PENDING',
  'KYC_EXPIRED',
  'LIMIT_EXCEEDED_DAILY',
  'LIMIT_EXCEEDED_MONTHLY',
  'SCORING_DENIED',
  'SCORING_REVIEW_REQUIRED',
  'USER_BLOCKED',
  'WALLET_FROZEN',
  'HOLD_FAILED',
  'IDEMPOTENCY_CONFLICT',
  'ORDER_CREATION_FAILED',
  'RATE_SERVICE_UNAVAILABLE',
  'EXCHANGE_SERVICE_UNAVAILABLE',
  'UPSTREAM_TIMEOUT',
  'RATE_LIMITED',
  // Outside the §6 validation chain: this one belongs to reading an order, not
  // creating one. Added by orchestrator decision O-1 after the API contract
  // exposed the gap.
  'ORDER_NOT_FOUND',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/**
 * Where the message is rendered.
 * - `field`  — inline, right under the "You Pay" input (BRD §8: no modals for validation)
 * - `select` — inline, under the asset selector
 * - `banner` — compact banner above the submit button
 */
export type ErrorSurface = 'field' | 'select' | 'banner'

export interface ProblemDetails {
  type: string
  title: string
  status: number
  code: ErrorCode
  detail: string
  instance: string
  correlationId: string
  timestamp: string
  params?: Record<string, string>
  retryable: boolean
}

interface ErrorMeta {
  status: number
  retryable: boolean
  surface: ErrorSurface
  /** Message template shown to the user. `{placeholders}` are filled from `params`. */
  message: string
}

export const ERROR_CATALOG: Record<ErrorCode, ErrorMeta> = {
  VALIDATION_ERROR: { status: 400, retryable: false, surface: 'field', message: 'Enter a valid amount' },
  ASSET_NOT_SUPPORTED: { status: 422, retryable: false, surface: 'select', message: 'This asset is not available for exchange' },
  SAME_ASSET_PAIR: { status: 422, retryable: false, surface: 'select', message: 'Select two different assets' },
  PAIR_NOT_SUPPORTED: { status: 422, retryable: false, surface: 'select', message: 'This pair is not available right now' },
  AMOUNT_BELOW_MINIMUM: { status: 422, retryable: false, surface: 'field', message: 'Minimum amount is {min} {asset}' },
  AMOUNT_ABOVE_MAXIMUM: { status: 422, retryable: false, surface: 'field', message: 'Maximum amount is {max} {asset}' },
  INSUFFICIENT_FUNDS: { status: 422, retryable: false, surface: 'field', message: 'Not enough {asset}. Available: {available}' },
  QUOTE_NOT_FOUND: { status: 404, retryable: true, surface: 'banner', message: 'Rate expired. Refreshing…' },
  QUOTE_EXPIRED: { status: 409, retryable: true, surface: 'banner', message: 'Rate expired. We updated the quote.' },
  QUOTE_ALREADY_USED: { status: 409, retryable: false, surface: 'banner', message: 'This exchange was already submitted' },
  QUOTE_MISMATCH: { status: 409, retryable: true, surface: 'banner', message: 'Details changed. Please confirm again.' },
  RATE_CHANGED: { status: 409, retryable: true, surface: 'banner', message: 'Rate changed. Calculation updated.' },
  KYC_REQUIRED: { status: 403, retryable: false, surface: 'banner', message: 'Verify your identity to exchange' },
  KYC_LEVEL_INSUFFICIENT: { status: 403, retryable: false, surface: 'banner', message: 'Higher verification level required' },
  KYC_PENDING: { status: 403, retryable: true, surface: 'banner', message: 'Verification in progress' },
  KYC_EXPIRED: { status: 403, retryable: false, surface: 'banner', message: 'Your verification has expired' },
  LIMIT_EXCEEDED_DAILY: { status: 422, retryable: false, surface: 'field', message: 'Daily limit reached. Available today: {remaining}' },
  LIMIT_EXCEEDED_MONTHLY: { status: 422, retryable: false, surface: 'field', message: 'Monthly limit reached' },
  SCORING_DENIED: { status: 403, retryable: false, surface: 'banner', message: 'Operation declined. Contact support.' },
  SCORING_REVIEW_REQUIRED: { status: 202, retryable: false, surface: 'banner', message: 'Sent for manual review' },
  USER_BLOCKED: { status: 403, retryable: false, surface: 'banner', message: 'Account is restricted' },
  WALLET_FROZEN: { status: 403, retryable: false, surface: 'banner', message: 'Wallet is temporarily frozen' },
  HOLD_FAILED: { status: 409, retryable: true, surface: 'banner', message: 'Could not reserve funds. Try again.' },
  IDEMPOTENCY_CONFLICT: { status: 409, retryable: false, surface: 'banner', message: 'Conflicting request' },
  ORDER_CREATION_FAILED: { status: 500, retryable: true, surface: 'banner', message: 'Something went wrong. Try again.' },
  RATE_SERVICE_UNAVAILABLE: { status: 503, retryable: true, surface: 'banner', message: 'Rates are temporarily unavailable' },
  EXCHANGE_SERVICE_UNAVAILABLE: { status: 503, retryable: true, surface: 'banner', message: 'Exchange is temporarily unavailable' },
  UPSTREAM_TIMEOUT: { status: 504, retryable: true, surface: 'banner', message: 'Request timed out. Try again.' },
  RATE_LIMITED: { status: 429, retryable: true, surface: 'banner', message: 'Too many requests. Slow down.' },
  ORDER_NOT_FOUND: { status: 404, retryable: false, surface: 'banner', message: 'Order not found' },
}

/** Error thrown by the mock API layer. Carries the full Problem Details payload. */
export class ApiError extends Error {
  readonly problem: ProblemDetails

  constructor(problem: ProblemDetails) {
    super(`${problem.code}: ${problem.detail}`)
    this.name = 'ApiError'
    this.problem = problem
  }

  get code(): ErrorCode {
    return this.problem.code
  }

  get surface(): ErrorSurface {
    return ERROR_CATALOG[this.problem.code].surface
  }

  /** User-facing message with `{placeholders}` resolved from `params`. */
  get userMessage(): string {
    const template = ERROR_CATALOG[this.problem.code].message
    const params = this.problem.params ?? {}
    return template.replace(/\{(\w+)\}/g, (whole, key: string) => params[key] ?? whole)
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError
}
