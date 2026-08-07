/**
 * Money arithmetic.
 *
 * Implements `docs/00-canonical-model.md` §5 exactly. Every rule below is
 * normative — changing a rounding mode here silently changes what the user is
 * promised, so each function names the canonical clause it implements.
 *
 * Hard rule: values enter and leave this module as decimal STRINGS. `Decimal`
 * instances stay inside. No `number` ever touches a monetary value.
 */

import Decimal from 'decimal.js'
import type { FeePolicy, Money, Rate } from './types'

// 40 significant digits is far beyond anything we handle (BTC needs 8 decimals
// on values up to ~10^8) and leaves headroom for intermediate products.
Decimal.set({ precision: 40, toExpNeg: -30, toExpPos: 40 })

/** Canonical §5.1. Non-negative decimal, up to 18 integer and 18 fractional digits. */
export const MONEY_PATTERN = /^(0|[1-9]\d{0,18})(\.\d{1,18})?$/

export function isValidMoney(value: string): boolean {
  return MONEY_PATTERN.test(value)
}

/**
 * What the user is allowed to have in the input field while typing.
 * Deliberately more permissive than MONEY_PATTERN: a lone "0." or an empty
 * string is an intermediate state, not an error. BRD §8 — do not shout at the
 * user mid-typing.
 */
export const PARTIAL_INPUT_PATTERN = /^\d{0,19}([.,]\d{0,18})?$/

function d(value: Money | Rate): Decimal {
  return new Decimal(value)
}

/** Canonical §5.4 — ROUND_DOWN. Used for everything the user receives. */
export function roundDown(value: Money, decimals: number): Money {
  return d(value).toDecimalPlaces(decimals, Decimal.ROUND_DOWN).toFixed(decimals)
}

/** Canonical §5.4 — ROUND_UP. Used for the fee. */
export function roundUp(value: Money, decimals: number): Money {
  return d(value).toDecimalPlaces(decimals, Decimal.ROUND_UP).toFixed(decimals)
}

/** Display-only rounding (canonical §5.4, inverseRate row). */
export function roundHalfUp(value: Money | Rate, decimals: number): string {
  return d(value).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toFixed(decimals)
}

export function normalize(value: Money, decimals: number): Money {
  return d(value).toFixed(decimals)
}

export const gt = (a: Money, b: Money): boolean => d(a).gt(d(b))
export const gte = (a: Money, b: Money): boolean => d(a).gte(d(b))
export const lt = (a: Money, b: Money): boolean => d(a).lt(d(b))
export const lte = (a: Money, b: Money): boolean => d(a).lte(d(b))
export const eq = (a: Money, b: Money): boolean => d(a).eq(d(b))
export const isZero = (a: Money): boolean => d(a).isZero()
export const isPositive = (a: Money): boolean => d(a).gt(0)

export const add = (a: Money, b: Money): Money => d(a).plus(d(b)).toString()
export const sub = (a: Money, b: Money): Money => d(a).minus(d(b)).toString()
export const mul = (a: Money, b: Money): Money => d(a).times(d(b)).toString()
export const div = (a: Money, b: Money): Money => d(a).div(d(b)).toString()

/** Exact integer power. Used for the simulated market tick, where the rate is
 *  the base rate multiplied by a coefficient once per elapsed window. */
export function pow(base: Money, exponent: number): Money {
  if (exponent === 0) return '1'
  return d(base).pow(exponent).toString()
}

/** Number of fractional digits actually present in a decimal string. */
export function decimalPlaces(value: Money): number {
  const dot = value.indexOf('.')
  return dot === -1 ? 0 : value.length - dot - 1
}

export interface QuoteAmounts {
  fromAmount: Money
  feeAmount: Money
  netFromAmount: Money
  toAmount: Money
}

/**
 * Canonical §5.3 — the six-step calculation, in order.
 *
 * The fee is INCLUDED_IN_SOURCE: it is taken out of what the user typed, not
 * added on top. That is what makes MAX / 100 % reachable at all — see the
 * trade-off recorded in canonical §5.3 and promtlog conflict C-06.
 *
 * Postconditions (canonical §5.4, invariants I1/I2/I4/I5):
 *   feeAmount + netFromAmount === fromAmount   (exact)
 *   toAmount <= netFromAmount * rate
 */
export function calculateQuoteAmounts(input: {
  rawFromAmount: Money
  rate: Rate
  policy: FeePolicy
  fromDecimals: number
  toDecimals: number
}): QuoteAmounts {
  const { rawFromAmount, rate, policy, fromDecimals, toDecimals } = input

  // 1. fromAmount, normalised to the source asset precision.
  const fromAmount = roundDown(rawFromAmount, fromDecimals)

  // 2..3. fee = clamp(fromAmount * percent / 100, minFee, maxFee), ROUND_UP.
  const feeRaw = d(fromAmount).times(policy.percent).div(100)
  let fee = feeRaw
  if (feeRaw.lt(policy.minFee)) fee = d(policy.minFee)
  if (policy.maxFee !== null && fee.gt(policy.maxFee)) fee = d(policy.maxFee)
  let feeAmount = roundUp(fee.toString(), fromDecimals)

  // The fee can never exceed what the user is paying: with a minFee and a tiny
  // amount, the clamp above could otherwise produce a negative net. The caller
  // still rejects such an amount via AMOUNT_BELOW_MINIMUM, but the arithmetic
  // must not produce a negative number on the way there (invariant I4).
  if (gt(feeAmount, fromAmount)) {
    feeAmount = fromAmount
  }

  // 4. net = fromAmount − fee. Exact, both already at fromDecimals.
  const netFromAmount = d(fromAmount).minus(feeAmount).toFixed(fromDecimals)

  // 5..6. toAmount = net * rate, ROUND_DOWN to the target asset precision.
  const toAmount = roundDown(d(netFromAmount).times(rate).toString(), toDecimals)

  return { fromAmount, feeAmount, netFromAmount, toAmount }
}

/** Runtime check of the canonical invariants I1, I2, I4 and I5. Used by the mock
 *  BFF before it hands a quote out, so a broken calculation fails loudly instead
 *  of silently shipping wrong numbers to the screen. */
export function assertQuoteInvariants(
  a: QuoteAmounts,
  rate: Rate,
  precision?: { fromDecimals: number; toDecimals: number },
): void {
  if (!eq(add(a.feeAmount, a.netFromAmount), a.fromAmount)) {
    throw new Error(`I1 violated: ${a.feeAmount} + ${a.netFromAmount} != ${a.fromAmount}`)
  }
  if (gt(a.toAmount, mul(a.netFromAmount, rate))) {
    throw new Error(`I2 violated: toAmount ${a.toAmount} exceeds net*rate`)
  }
  for (const v of [a.fromAmount, a.feeAmount, a.netFromAmount, a.toAmount]) {
    if (d(v).isNegative()) throw new Error(`I4 violated: negative value ${v}`)
  }
  if (precision) {
    // I5 — a value carrying more decimals than its asset supports cannot be
    // settled and would be silently truncated somewhere downstream.
    const over = (label: string, value: Money, max: number) => {
      if (decimalPlaces(value) > max) {
        throw new Error(`I5 violated: ${label} ${value} exceeds ${max} decimals`)
      }
    }
    over('fromAmount', a.fromAmount, precision.fromDecimals)
    over('feeAmount', a.feeAmount, precision.fromDecimals)
    over('netFromAmount', a.netFromAmount, precision.fromDecimals)
    over('toAmount', a.toAmount, precision.toDecimals)
  }
}

/**
 * Quick-select chips (BRD §4) and the MAX button (Design Brief).
 * ROUND_DOWN so the result is always spendable — rounding up would produce an
 * amount the user cannot actually afford.
 */
export function percentOfBalance(available: Money, percent: number, decimals: number): Money {
  return roundDown(d(available).times(percent).div(100).toString(), decimals)
}

/** Canonical §5.2 — display-only inverse of the rate. */
export function inverseRate(rate: Rate, displayDecimals = 2): Rate {
  if (d(rate).isZero()) return '0'
  return roundHalfUp(new Decimal(1).div(rate).toString(), displayDecimals)
}

/**
 * Absolute relative drift between two rates, in percent.
 *
 * Magnitude only — use it to SHOW how far a rate moved. To decide whether a
 * move is worth interrupting anyone, use `adverseRateDriftPercent`: direction
 * matters there, and this function has thrown it away.
 */
export function rateDriftPercent(oldRate: Rate, newRate: Rate): number {
  if (d(oldRate).isZero()) return 0
  return d(newRate).minus(oldRate).div(oldRate).abs().times(100).toNumber()
}

/** Signed change of the rate, in percent. Negative means the rate fell. */
export function rateChangePercent(quotedRate: Rate, liveRate: Rate): number {
  if (d(quotedRate).isZero()) return 0
  return d(liveRate).minus(quotedRate).div(quotedRate).times(100).toNumber()
}

/**
 * Drift **against the system**, in percent. Zero when the market moved the
 * other way (canonical §6.1, decision O-18).
 *
 * The threshold is one-sided on purpose. `rate` is units of toAsset per unit of
 * fromAsset (§5.2), so a FALLING rate is the adverse direction: the quote still
 * owes the user the amount it displayed, and the system now has to source it at
 * a worse price. That is the only case where honouring the lock can become
 * untenable, and the only case worth a banner.
 *
 * When the rate rises, the user receives exactly the sum they confirmed — the
 * quote is honoured at the locked rate either way — and the difference stays
 * with the system. Nothing about the user's outcome has changed, so raising
 * "Rate changed" there would be noise, and noise is what teaches people to
 * dismiss the banner that actually matters. Measuring with `.abs()` did exactly
 * that half the time.
 */
export function adverseRateDriftPercent(quotedRate: Rate, liveRate: Rate): number {
  const change = rateChangePercent(quotedRate, liveRate)
  return change < 0 ? -change : 0
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const GROUP_SEPARATOR = ' ' // non-breaking space, per BRD §7 example "25 450"

function groupIntegerPart(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP_SEPARATOR)
}

/**
 * Renders a decimal string for display. Never converts to `number`, so precision
 * survives regardless of magnitude.
 *
 * `trimTrailingZeros` is for crypto amounts: "0.01420000" reads as noise, while
 * "0.0142" reads as a number. Fiat keeps its 2 decimals — "25 450" without the
 * ".00" looks like a rounded figure in a financial context.
 */
export function formatAmount(
  value: Money,
  decimals: number,
  options: { trimTrailingZeros?: boolean; minDecimals?: number } = {},
): string {
  const { trimTrailingZeros = false, minDecimals = 0 } = options
  const fixed = d(value).toFixed(decimals, Decimal.ROUND_DOWN)
  let [intPart, fracPart = ''] = fixed.split('.')

  if (trimTrailingZeros && fracPart) {
    fracPart = fracPart.replace(/0+$/, '')
    while (fracPart.length < minDecimals) fracPart += '0'
  }

  const grouped = groupIntegerPart(intPart)
  return fracPart ? `${grouped}.${fracPart}` : grouped
}

/**
 * Human-readable rate line for the summary, e.g. "1 USDT = 94.00 RUB".
 *
 * Deliberately shows the INVERSE direction when the direct rate is a small
 * fraction: "1 RUB = 0.010638 USDT" is technically the same statement but
 * people cannot price-check it at a glance.
 */
export function formatRateLine(
  rate: Rate,
  fromAssetId: string,
  toAssetId: string,
  fromDisplayDecimals: number,
): string {
  if (d(rate).lt(1)) {
    const inv = inverseRate(rate, fromDisplayDecimals)
    return `1 ${toAssetId} = ${formatAmount(inv, fromDisplayDecimals, { trimTrailingZeros: true, minDecimals: 2 })} ${fromAssetId}`
  }
  return `1 ${fromAssetId} = ${formatAmount(rate, fromDisplayDecimals, { trimTrailingZeros: true, minDecimals: 2 })} ${toAssetId}`
}

/** Normalises what the user typed ("1 234,56" → "1234.56") without validating it. */
export function sanitizeInput(raw: string): string {
  return raw.replace(/[\s  ]/g, '').replace(',', '.')
}
