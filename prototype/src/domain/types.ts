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
}

export type RateSource = 'AGGREGATED' | 'BINANCE' | 'CBR' | 'INTERNAL'

export interface Quote {
  quoteId: string
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
  fromAsset: AssetRef
  toAsset: AssetRef
  fromAmount: Money
  feeAmount: Money
  toAmount: Money
  rate: Rate
  holdId: string
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

export interface LimitBucket {
  period: 'DAILY' | 'MONTHLY'
  /** Normalised to a single accounting currency (RUB in the fixtures). */
  limit: Money
  used: Money
  remaining: Money
  resetsAt: Timestamp
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
