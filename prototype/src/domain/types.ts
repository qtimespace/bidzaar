/**
 * Domain types.
 *
 * Mirrors `docs/00-canonical-model.md` §4. Field names are normative — they must
 * stay identical to the OpenAPI contract in `docs/api/exchange-orders.openapi.yaml`.
 *
 * Money rule (canonical §5.1): every monetary value and every rate is a decimal
 * STRING. Binary floats are forbidden across the whole path — transport, state,
 * rendering. `number` is allowed only for non-monetary values (timers, percents
 * of the quick-select chips, decimals count).
 */

/** Decimal string, e.g. "25450.00". Validated by MONEY_PATTERN in money.ts. */
export type Money = string

/** Decimal string holding an exchange rate, e.g. "0.010638297872". */
export type Rate = string

/** ISO-8601 UTC timestamp with milliseconds, e.g. "2026-08-07T10:15:32.117Z". */
export type Timestamp = string

export type AssetType = 'FIAT' | 'CRYPTO'

/** Blockchain network. Absent for fiat assets. */
export type Network = 'TRON' | 'ETHEREUM' | 'BITCOIN'

export interface Asset {
  assetId: string
  type: AssetType
  /** Required for CRYPTO. `USDT@TRON` and `USDT@ETHEREUM` are different balances. */
  network?: Network
  decimals: number
  symbol: string
  displayName: string
}

/** Minimal reference to an asset, used in requests and quotes. */
export interface AssetRef {
  assetId: string
  network?: Network
}

export interface Balance {
  assetId: string
  network?: Network
  total: Money
  held: Money
  /** Invariant: available = total − held, always ≥ 0. All checks use this one. */
  available: Money
}

export type FeeMode = 'INCLUDED_IN_SOURCE'

export interface FeePolicy {
  mode: FeeMode
  /** Percent as a decimal string: "0.35" means 0.35 %. */
  percent: string
  minFee: Money
  maxFee: Money | null
  /** Always "0" for an internal exchange — no on-chain transfer happens. */
  networkFee: Money
}

export interface PairConfig {
  fromAssetId: string
  toAssetId: string
  minAmount: Money
  maxAmount: Money
  feePolicy: FeePolicy
  enabled: boolean
  /**
   * Rate-drift tolerance for THIS pair, in percent ("0.20" means 0.20 %).
   *
   * Decision O-8: a single global threshold is sound for RUB→USDT and almost
   * guarantees RATE_CHANGED on every confirmation for RUB→BTC, whose own
   * volatility exceeds it — the guard rail turns into noise the user learns to
   * click through. Supplied per pair by S4; when absent, the default applies.
   */
  driftThresholdPercent?: string
}

export type RateSource = 'AGGREGATED' | 'BINANCE' | 'CBR' | 'INTERNAL'

/**
 * Which side of the calculation the client fixed (decision O-9).
 *
 * `SELL` — the debit amount is given, the credit amount is derived.
 * `BUY`  — the credit amount is given, the debit amount is derived.
 *
 * The given side is never rounded; the derived side is rounded in the system's
 * favour (canonical §5.4).
 */
export type QuoteSide = 'SELL' | 'BUY'

export interface Quote {
  quoteId: string
  /** Which side the client fixed. `SELL` in this prototype — see createQuote. */
  side: QuoteSide
  /**
   * The amount as originally requested: `fromAmount` when side is SELL,
   * `toAmount` when side is BUY. Canonical §5.4 requires the snapshot to carry
   * it — without the pair (side, requestedAmount) the calculation can be
   * reproduced two different ways and stops being auditable.
   */
  requestedAmount: Money
  fromAsset: AssetRef
  toAsset: AssetRef
  /** Full debited amount, fee included. */
  fromAmount: Money
  /** Charged in the source asset. */
  feeAmount: Money
  /** fromAmount − feeAmount, the part that is actually converted. */
  netFromAmount: Money
  toAmount: Money
  /** Units of toAsset per 1 unit of fromAsset. */
  rate: Rate
  /** Display only — humans read "1 USDT = 94.00 RUB" more easily. */
  inverseRate: Rate
  feePolicy: FeePolicy
  rateSource: RateSource
  quotedAt: Timestamp
  /** quotedAt + RATE_LOCK_TTL_MS. */
  expiresAt: Timestamp
  /** True when the quote was built from cached data because a source degraded. */
  degraded: boolean
}

/** Canonical §8. Only PENDING and MANUAL_REVIEW are reachable within this scope. */
export type OrderStatus =
  | 'PENDING'
  | 'MANUAL_REVIEW'
  | 'REJECTED'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'EXPIRED'

export interface ExchangeOrder {
  orderId: string
  status: OrderStatus
  quoteId: string
  /** Copied from the quote — the order doubles as the audit record (§5.4). */
  side: QuoteSide
  requestedAmount: Money
  fromAsset: AssetRef
  toAsset: AssetRef
  fromAmount: Money
  feeAmount: Money
  toAmount: Money
  rate: Rate
  /** `null` when no reserve exists: REJECTED, or the hold was already released. */
  holdId: string | null
  createdAt: Timestamp
  estimatedCompletionAt: Timestamp
  idempotencyKey: string
  correlationId: string
}

export type KycLevel = 0 | 1 | 2 | 3

export type KycStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'

export interface KycState {
  level: KycLevel
  status: KycStatus
  validUntil: Timestamp | null
  allowedOperations: string[]
}

export type LimitPeriod = 'DAILY' | 'MONTHLY' | 'YEARLY'

export interface LimitBucket {
  period: LimitPeriod
  /** Normalised to a single accounting currency (RUB in the fixtures). */
  limit: Money
  used: Money
  remaining: Money
  resetsAt: Timestamp
  /**
   * IANA zone the window is computed in (decision O-11). Accounting is UTC, so
   * a resident of AE sees the daily window reset at 04:00 local — a number the
   * user cannot explain unless we say which clock it is on.
   */
  resetTimeZone: string
  currency: string
}

export type ScoringDecision = 'ALLOW' | 'REVIEW' | 'DENY'

export interface ScoringResult {
  score: number
  decision: ScoringDecision
  reasons: string[]
  caseId: string | null
}

export interface UserProfile {
  userId: string
  displayName: string
  residency: string
  tier: string
  status: 'ACTIVE' | 'BLOCKED' | 'SUSPENDED'
}
