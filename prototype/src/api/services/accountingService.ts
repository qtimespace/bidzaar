/**
 * S6 — Accounting Service (mock). Plays the role of BRD's "Wallet Service".
 *
 * Contract: `docs/api/integrations/accounting.yaml`, described in
 * `docs/api/INTEGRATIONS.md` §S6. Critical class: Blocking.
 *
 * What the app receives: balances as total/held/available, and the result of
 * creating or releasing a hold. Used at validation steps 17 and 18
 * (canonical §6).
 *
 * Balances are never cached (canonical §11): a stale balance turns into either
 * a false rejection or a reservation failure after the user already confirmed.
 */

import type { Balance } from '@/domain/types'
import { BALANCES } from '../fixtures'
import { delay, ulid } from '../transport'

export interface BalancesResponse {
  balances: Balance[]
  /** Optimistic-locking token. A hold created against a stale version is rejected. */
  version: number
  fetchedAt: string
}

export async function getBalances(): Promise<BalancesResponse> {
  await delay(90)
  return { balances: BALANCES, version: 1, fetchedAt: new Date().toISOString() }
}

export interface HoldResponse {
  holdId: string
  assetId: string
  amount: string
  createdAt: string
  expiresAt: string
}

/**
 * Reserves funds. Idempotent by `idempotencyKey`: the same key returns the same
 * hold rather than reserving twice. Timeout 1500 ms and NO retry — retrying a
 * non-idempotent financial write is how double reservations happen.
 */
export async function createHold(input: {
  assetId: string
  amount: string
  idempotencyKey: string
}): Promise<HoldResponse> {
  await delay(120)
  const now = Date.now()
  return {
    holdId: `hold_${ulid(now)}`,
    assetId: input.assetId,
    amount: input.amount,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
  }
}

/**
 * Compensating action for the saga in SDD §12: if order registration fails
 * after the hold succeeded, the hold must be released or the user's money stays
 * frozen with nothing to show for it.
 */
export async function releaseHold(holdId: string): Promise<void> {
  await delay(60)
  void holdId
}
