/**
 * Hardcoded fixtures — the single source of truth for the prototype.
 *
 * Mirrors `docs/00-canonical-model.md` §10. The prototype makes no network
 * calls and has no authentication, per the customer's instruction: the point of
 * the exercise is the exchange screen and the documented contracts behind it,
 * not a backend.
 *
 * Every number here also appears in `docs/features/exchange-order.feature`.
 * If you change a fixture, the Gherkin examples stop matching.
 */

import type {
  Asset,
  Balance,
  KycState,
  LimitBucket,
  PairConfig,
  Rate,
  ScoringResult,
  UserProfile,
} from '@/domain/types'

export const USER: UserProfile = {
  userId: 'usr_01J8ZQ4H9K2M3N4P5R6S7T8V9W',
  displayName: 'Alex Morgan',
  residency: 'AE',
  tier: 'TIER_2',
  status: 'ACTIVE',
}

export const KYC: KycState = {
  level: 2,
  status: 'APPROVED',
  // End of day, not start: verification is valid through its final day.
  validUntil: '2027-04-30T23:59:59.000Z',
  allowedOperations: ['EXCHANGE', 'DEPOSIT', 'WITHDRAW'],
}

export const SCORING: ScoringResult = {
  score: 17,
  decision: 'ALLOW',
  reasons: [],
  caseId: null,
}

export const ASSETS: Asset[] = [
  { assetId: 'RUB', type: 'FIAT', decimals: 2, symbol: '₽', displayName: 'Russian Ruble' },
  { assetId: 'USDT', type: 'CRYPTO', network: 'TRON', decimals: 6, symbol: '₮', displayName: 'Tether USD' },
  { assetId: 'BTC', type: 'CRYPTO', network: 'BITCOIN', decimals: 8, symbol: '₿', displayName: 'Bitcoin' },
  { assetId: 'ETH', type: 'CRYPTO', network: 'ETHEREUM', decimals: 8, symbol: 'Ξ', displayName: 'Ethereum' },
  { assetId: 'EUR', type: 'FIAT', decimals: 2, symbol: '€', displayName: 'Euro' },
]

/**
 * ETH deliberately carries a non-zero `held` so the screen has to demonstrate
 * the difference between total and available. EUR is deliberately empty so the
 * zero-balance state is reachable without editing code.
 */
export const BALANCES: Balance[] = [
  { assetId: 'RUB', total: '25450.00', held: '0.00', available: '25450.00' },
  { assetId: 'USDT', network: 'TRON', total: '135.270000', held: '0.000000', available: '135.270000' },
  { assetId: 'BTC', network: 'BITCOIN', total: '0.01420000', held: '0.00000000', available: '0.01420000' },
  { assetId: 'ETH', network: 'ETHEREUM', total: '0.86000000', held: '0.10000000', available: '0.76000000' },
  { assetId: 'EUR', total: '0.00', held: '0.00', available: '0.00' },
]

export const DEFAULT_FROM_ASSET = 'RUB'
export const DEFAULT_TO_ASSET = 'USDT'

/**
 * Mid rates, units of `to` per 1 unit of `from`.
 *
 * The direct and inverse pairs are NOT reciprocals on purpose (RUB→USDT implies
 * 94.00 while USDT→RUB is 93.60). Real rates carry a bid/ask spread; deriving
 * one direction as 1/other would quietly hide it.
 */
export const RATES: Record<string, Rate> = {
  'RUB/USDT': '0.010638297872',
  'USDT/RUB': '93.60',
  'RUB/BTC': '0.00000016',
  'USDT/BTC': '0.0000150',
  'USDT/ETH': '0.000410',
  'BTC/USDT': '66200.00',
  'ETH/USDT': '2420.00',
  'RUB/EUR': '0.0098',
}

export const pairKey = (from: string, to: string): string => `${from}/${to}`

const feePolicy = (percent: string, minFee: string) =>
  ({ mode: 'INCLUDED_IN_SOURCE', percent, minFee, maxFee: null, networkFee: '0' }) as const

/**
 * `EUR→*` is deliberately absent: it is the fixture that makes
 * PAIR_NOT_SUPPORTED reachable from the UI without a dev switch.
 */
export const PAIRS: PairConfig[] = [
  { fromAssetId: 'RUB', toAssetId: 'USDT', minAmount: '500.00', maxAmount: '1000000.00', feePolicy: feePolicy('0.35', '10.00'), enabled: true },
  { fromAssetId: 'USDT', toAssetId: 'RUB', minAmount: '5.000000', maxAmount: '10000.000000', feePolicy: feePolicy('0.35', '0.50'), enabled: true },
  { fromAssetId: 'RUB', toAssetId: 'BTC', minAmount: '1000.00', maxAmount: '1000000.00', feePolicy: feePolicy('0.50', '10.00'), enabled: true },
  { fromAssetId: 'USDT', toAssetId: 'BTC', minAmount: '10.000000', maxAmount: '10000.000000', feePolicy: feePolicy('0.40', '0.50'), enabled: true },
  { fromAssetId: 'USDT', toAssetId: 'ETH', minAmount: '10.000000', maxAmount: '10000.000000', feePolicy: feePolicy('0.40', '0.50'), enabled: true },
  { fromAssetId: 'BTC', toAssetId: 'USDT', minAmount: '0.00020000', maxAmount: '2.00000000', feePolicy: feePolicy('0.40', '0.00005'), enabled: true },
  { fromAssetId: 'ETH', toAssetId: 'USDT', minAmount: '0.00500000', maxAmount: '50.00000000', feePolicy: feePolicy('0.40', '0.0005'), enabled: true },
  { fromAssetId: 'RUB', toAssetId: 'EUR', minAmount: '1000.00', maxAmount: '500000.00', feePolicy: feePolicy('0.60', '20.00'), enabled: true },
]

/** Limits are normalised to a single accounting currency (RUB), per canonical §10.5. */
export const LIMITS: LimitBucket[] = [
  { period: 'DAILY', limit: '500000.00', used: '180000.00', remaining: '320000.00', resetsAt: '2026-08-08T00:00:00.000Z', currency: 'RUB' },
  { period: 'MONTHLY', limit: '5000000.00', used: '1240000.00', remaining: '3760000.00', resetsAt: '2026-09-01T00:00:00.000Z', currency: 'RUB' },
]

/** Cross-rates to RUB, used to normalise a request against the RUB-denominated limits. */
export const RUB_EQUIVALENT: Record<string, Rate> = {
  RUB: '1',
  USDT: '93.60',
  BTC: '6197000.00',
  ETH: '226512.00',
  EUR: '102.04',
}

export const RATE_SOURCE = 'AGGREGATED' as const

/** Crypto Provider (S7) snapshot — degradable, so the screen must survive its absence. */
export const NETWORK_STATUS: Record<string, { congestion: 'LOW' | 'MEDIUM' | 'HIGH'; estimatedConfirmationSec: number }> = {
  TRON: { congestion: 'LOW', estimatedConfirmationSec: 60 },
  ETHEREUM: { congestion: 'MEDIUM', estimatedConfirmationSec: 180 },
  BITCOIN: { congestion: 'LOW', estimatedConfirmationSec: 600 },
}

export const helpers = {
  getAsset(assetId: string): Asset | undefined {
    return ASSETS.find((a) => a.assetId === assetId)
  },
  getBalance(assetId: string): Balance | undefined {
    return BALANCES.find((b) => b.assetId === assetId)
  },
  getPair(from: string, to: string): PairConfig | undefined {
    return PAIRS.find((p) => p.fromAssetId === from && p.toAssetId === to)
  },
  getRate(from: string, to: string): Rate | undefined {
    return RATES[pairKey(from, to)]
  },
  decimalsOf(assetId: string): number {
    return helpers.getAsset(assetId)?.decimals ?? 2
  },
}
