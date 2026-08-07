/**
 * S5 — Exchange Rate Service (mock).
 *
 * Contract: `docs/api/integrations/exchange-rates.yaml`, described in
 * `docs/api/INTEGRATIONS.md` §S5. Critical class: Blocking.
 *
 * What the app receives: bid/ask/mid for a pair, the price source, a staleness
 * flag and a TTL. Used at validation steps 6..10 (canonical §6).
 *
 * Degradation (canonical §11): a cached rate may be served for up to 10 s with
 * `degraded: true`; beyond that the call fails with RATE_SERVICE_UNAVAILABLE.
 * Serving an unbounded stale rate would mean quoting a price we cannot honour.
 */

import type { Rate, RateSource } from '@/domain/types'
import { helpers, pairKey, RATE_SOURCE } from '../fixtures'
import { getScenario, getScenarioActivatedAt } from '../scenarios'
import { delay, fail, nowIso } from '../transport'
import { elapsedTickWindows, rateTickFactor } from '../runtimeConfig'
import { mul, pow } from '@/domain/money'

/** Anchor for the market simulation: rates move relative to when the session
 *  began, so a reload starts from the published fixture rate. */
const SESSION_START = Date.now()

/** How long after the scenario starts the rate moves, in RATE_DRIFT. */
const DRIFT_AFTER_MS = 7000

/**
 * Post-drift rates, given as exact values rather than as a multiplier.
 *
 * A multiplier looked tidier but was wrong: `base × 0.9947` yields
 * `0.0105819148…`, while `docs/features/exchange-order.feature` scenario 15
 * documents `0.010582010582` — the rate implied by 1 USDT = 94.50 RUB. The two
 * differ in the sixth decimal of the received amount, which is exactly the kind
 * of quiet mismatch between an acceptance artefact and an implementation that
 * this project is supposed to avoid. Pinning the value keeps the demo and the
 * feature file arithmetically identical.
 */
const DRIFTED_RATES: Record<string, Rate> = {
  // 1 USDT = 94.50 RUB, i.e. −0.529 % against the user.
  'RUB/USDT': '0.010582010582',
}

/**
 * Fallback for pairs without a pinned value. −0.53 %, deliberately AGAINST the
 * user: a rate that improves needs no confirmation, so it would never exercise
 * the "accept the new terms" path of BRD §8.
 */
const DRIFT_FACTOR = '0.9947'

export interface RateQuote {
  fromAssetId: string
  toAssetId: string
  rate: Rate
  source: RateSource
  quotedAt: string
  ttlSeconds: number
  stale: boolean
}

/** Timeout in production: 800 ms — the user waits for this one synchronously. */
export async function getRate(fromAssetId: string, toAssetId: string): Promise<RateQuote> {
  await delay(110)

  const scenario = getScenario()

  if (scenario === 'RATES_DOWN') {
    fail(
      'RATE_SERVICE_UNAVAILABLE',
      'Rate provider did not respond within the 800 ms budget and no fresh cached rate is available',
      { instance: '/v1/exchange/quotes' },
    )
  }

  const base = helpers.getRate(fromAssetId, toAssetId)
  if (base === undefined) {
    fail('PAIR_NOT_SUPPORTED', `No rate is published for ${fromAssetId}/${toAssetId}`, {
      instance: '/v1/exchange/quotes',
      params: { fromAssetId, toAssetId },
    })
  }

  const now = Date.now()

  const hasDrifted = scenario === 'RATE_DRIFT' && now - getScenarioActivatedAt() > DRIFT_AFTER_MS
  const drifted = hasDrifted ? (DRIFTED_RATES[pairKey(fromAssetId, toAssetId)] ?? mul(base, DRIFT_FACTOR)) : base

  // Market tick: the published rate moves once per window, and the window is
  // the rate lock TTL. Without it every auto-refresh returned the identical
  // number and the 15-second lock looked decorative — the user could not tell
  // whether the quote had actually been re-priced or the timer was theatre.
  const windows = elapsedTickWindows(SESSION_START, now)
  const rate = windows === 0 ? drifted : mul(drifted, pow(rateTickFactor(), windows))

  return {
    fromAssetId,
    toAssetId,
    rate,
    source: RATE_SOURCE,
    quotedAt: nowIso(),
    ttlSeconds: 15,
    stale: false,
  }
}
