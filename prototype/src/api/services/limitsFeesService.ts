/**
 * S4 — Limits & Fees Service (mock).
 *
 * Contract: `docs/api/integrations/limits-fees.yaml`, described in
 * `docs/api/INTEGRATIONS.md` §S4. Critical class: Blocking.
 *
 * What the app receives: per-pair min/max amounts, the fee schedule for the
 * user's tier, and turnover limit buckets with remaining balances normalised to
 * one accounting currency. Used at validation steps 3, 5, 11, 12 and 15
 * (canonical §6).
 */

import type { LimitBucket, PairConfig } from '@/domain/types'
import { LIMITS, PAIRS, RUB_EQUIVALENT } from '../fixtures'
import { getScenario } from '../scenarios'
import { delay } from '../transport'
import { mul } from '@/domain/money'

/** Timeout 1000 ms, cache TTL 60 s, stale allowed (canonical §11). */
export async function getPairs(): Promise<PairConfig[]> {
  await delay(60)
  return PAIRS
}

export async function getLimits(): Promise<LimitBucket[]> {
  await delay(60)

  if (getScenario() === 'LIMIT_HIT') {
    // Daily window nearly exhausted: any sizeable exchange trips the limit,
    // while small ones still pass. That asymmetry is what makes the scenario
    // useful — a hard "always fails" switch would not exercise the boundary.
    return LIMITS.map((bucket) =>
      bucket.period === 'DAILY'
        ? { ...bucket, used: '495000.00', remaining: '5000.00' }
        : bucket,
    )
  }

  return LIMITS
}

/**
 * Converts an amount into the limits' accounting currency (RUB).
 *
 * A dedicated cross-rate table is used rather than the trading rate: limit
 * accounting must not move with the spread, otherwise the same transaction
 * consumes a different share of the limit depending on direction.
 */
export function toLimitCurrency(assetId: string, amount: string): string {
  const factor = RUB_EQUIVALENT[assetId] ?? '0'
  return mul(amount, factor)
}
