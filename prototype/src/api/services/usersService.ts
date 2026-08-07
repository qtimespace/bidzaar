/**
 * S1 — Users Service (mock).
 *
 * Contract: `docs/api/integrations/users.yaml`, described in
 * `docs/api/INTEGRATIONS.md` §S1. Critical class: Blocking.
 *
 * What the app receives: identity, residency, service tier, account status and
 * restriction flags. Used at validation step 13 (canonical §6).
 */

import type { UserProfile } from '@/domain/types'
import { USER } from '../fixtures'
import { delay } from '../transport'

export interface UserProfileResponse extends UserProfile {
  /** Restriction flags. Any active flag blocks the exchange before funds are touched. */
  restrictions: string[]
  walletIds: string[]
}

/** Timeout in production: 1000 ms (canonical §11). Cached for the session. */
export async function getUserProfile(): Promise<UserProfileResponse> {
  await delay(80)
  return { ...USER, restrictions: [], walletIds: ['wlt_01J8ZQ4H9K2M3N4P5R6S7T8V9W'] }
}
