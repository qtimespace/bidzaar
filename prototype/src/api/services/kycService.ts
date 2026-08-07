/**
 * S2 — KYC Service (mock), modelled on a WebID-style identity provider.
 *
 * Contract: `docs/api/integrations/kyc-webid.yaml`, described in
 * `docs/api/INTEGRATIONS.md` §S2 (see ASSUMPTION-01 about the vendor).
 * Critical class: Blocking.
 *
 * What the app receives: verification level, status, validity window, allowed
 * operations. Used at validation step 14 (canonical §6).
 *
 * The KYC status is the one cached value we deliberately never serve stale
 * (canonical §11): letting an expired verification through is a regulatory
 * incident, while a failed check is only an inconvenience.
 */

import type { KycState } from '@/domain/types'
import { KYC } from '../fixtures'
import { getScenario } from '../scenarios'
import { delay } from '../transport'

export interface KycStateResponse extends KycState {
  verificationMethod: 'VIDEO_IDENT' | 'AUTO_IDENT' | 'EID' | null
  sanctionsHit: boolean
  pepFlag: boolean
  rejectionReasons: string[]
}

/** Timeout in production: 1000 ms, cache TTL 30 s, stale never served. */
export async function getKycState(): Promise<KycStateResponse> {
  await delay(70)

  if (getScenario() === 'KYC_PENDING') {
    return {
      level: 1,
      status: 'PENDING_REVIEW',
      validUntil: null,
      allowedOperations: [],
      verificationMethod: 'AUTO_IDENT',
      sanctionsHit: false,
      pepFlag: false,
      rejectionReasons: [],
    }
  }

  return {
    ...KYC,
    verificationMethod: 'VIDEO_IDENT',
    sanctionsHit: false,
    pepFlag: false,
    rejectionReasons: [],
  }
}

/** Minimum verification level required to exchange. Configuration, not a constant of nature. */
export const MIN_KYC_LEVEL_FOR_EXCHANGE = 2
