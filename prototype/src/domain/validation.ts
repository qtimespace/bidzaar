/**
 * Client-side pre-validation.
 *
 * Canonical §6, "Клиентская предвалидация": steps 1, 4, 5, 11, 12 and 17 are
 * cheap and local, so the screen runs them immediately and inline instead of
 * waiting for a round trip. This is a UX affordance, NOT a security boundary —
 * `exchangeApi.createOrder` re-runs the whole chain server-side and never
 * trusts anything decided here.
 *
 * Returning the same `ErrorCode` values as the server keeps one rendering path
 * for both sources of truth.
 */

import { ERROR_CATALOG, type ErrorCode, type ErrorSurface } from './errors'
import { gt, isValidMoney, isZero, lt, PARTIAL_INPUT_PATTERN } from './money'
import type { Asset, Balance, Money, PairConfig } from './types'
import { formatAmount } from './money'

export interface LocalValidationIssue {
  code: ErrorCode
  surface: ErrorSurface
  message: string
}

export interface LocalValidationInput {
  amount: Money | ''
  fromAsset: Asset | undefined
  toAsset: Asset | undefined
  pair: PairConfig | undefined
  balance: Balance | undefined
  /** Turnover limits, already normalised to the accounting currency. Optional:
   *  when absent the check is simply skipped and the server still enforces it. */
  limits?: { period: 'DAILY' | 'MONTHLY'; remaining: Money; currency: string }[]
  /** Converts `amount` from the source asset into the limits' currency. */
  toLimitCurrency?: (assetId: string, amount: Money) => Money
}

function issue(code: ErrorCode, params: Record<string, string> = {}): LocalValidationIssue {
  const meta = ERROR_CATALOG[code]
  return {
    code,
    surface: meta.surface,
    message: meta.message.replace(/\{(\w+)\}/g, (whole, key: string) => params[key] ?? whole),
  }
}

/**
 * Returns the FIRST violated rule, in canonical order — the same precedence the
 * server uses, so the user never sees the message change just because the
 * request reached the backend.
 *
 * `null` means "nothing to complain about yet", which includes an empty input:
 * BRD §8 asks us not to shout at someone who has not typed anything.
 */
export function validateLocally(input: LocalValidationInput): LocalValidationIssue | null {
  const { amount, fromAsset, toAsset, pair, balance, limits, toLimitCurrency } = input

  // Step 3 — assets must exist.
  if (!fromAsset || !toAsset) return issue('ASSET_NOT_SUPPORTED')

  // Step 4 — same asset (network included: USDT@TRON vs USDT@ETHEREUM differ).
  if (fromAsset.assetId === toAsset.assetId && fromAsset.network === toAsset.network) {
    return issue('SAME_ASSET_PAIR')
  }

  // Step 5 — pair must be enabled.
  if (!pair || !pair.enabled) return issue('PAIR_NOT_SUPPORTED')

  // Empty input is a neutral state, not an error.
  if (amount === '') return null

  // "1000." and "0." are half-typed, not wrong. Complaining here would fire
  // between the digits and the decimals of every amount anyone enters, which
  // is precisely the shouting BRD §8 asks us to avoid.
  if (PARTIAL_INPUT_PATTERN.test(amount) && amount.endsWith('.')) return null

  // Step 1 — format.
  if (!isValidMoney(amount)) return issue('VALIDATION_ERROR')
  if (isZero(amount)) return issue('VALIDATION_ERROR')

  // Step 11/12 — bounds for the pair.
  if (lt(amount, pair.minAmount)) {
    return issue('AMOUNT_BELOW_MINIMUM', {
      min: formatAmount(pair.minAmount, fromAsset.decimals, { trimTrailingZeros: true, minDecimals: 2 }),
      asset: fromAsset.assetId,
    })
  }
  if (gt(amount, pair.maxAmount)) {
    return issue('AMOUNT_ABOVE_MAXIMUM', {
      max: formatAmount(pair.maxAmount, fromAsset.decimals, { trimTrailingZeros: true, minDecimals: 2 }),
      asset: fromAsset.assetId,
    })
  }

  // Step 15 — turnover limits. Reproducible locally because both the remaining
  // allowance and the cross-rate arrive with the bootstrap, and the worst
  // moment to learn about a limit is after pressing the button.
  if (limits && toLimitCurrency) {
    const normalised = toLimitCurrency(fromAsset.assetId, amount)
    for (const bucket of limits) {
      if (gt(normalised, bucket.remaining)) {
        return issue(bucket.period === 'DAILY' ? 'LIMIT_EXCEEDED_DAILY' : 'LIMIT_EXCEEDED_MONTHLY', {
          remaining: `${bucket.remaining} ${bucket.currency}`,
        })
      }
    }
  }

  // Step 17 — available balance, never total. Checked last of the local rules
  // because the compliance checks that outrank it live server-side only.
  if (!balance) return issue('ASSET_NOT_SUPPORTED')
  if (gt(amount, balance.available)) {
    return issue('INSUFFICIENT_FUNDS', {
      asset: fromAsset.assetId,
      available: formatAmount(balance.available, fromAsset.decimals, { trimTrailingZeros: true, minDecimals: 2 }),
    })
  }

  return null
}
