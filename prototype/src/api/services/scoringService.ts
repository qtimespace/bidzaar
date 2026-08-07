/**
 * S3 — Scoring / AML Service (mock).
 *
 * Contract: `docs/api/integrations/scoring-aml.yaml`, described in
 * `docs/api/INTEGRATIONS.md` §S3. Critical class: Blocking.
 *
 * What the app receives: a 0..100 risk score, a decision, contributing factors
 * and a case id when manual review is required. Used at validation step 16
 * (canonical §6).
 *
 * REVIEW is not an error: it produces an accepted order in status
 * MANUAL_REVIEW (HTTP 202), which the screen renders as a distinct success-ish
 * state rather than a failure.
 */

import type { ScoringResult } from '@/domain/types'
import { SCORING } from '../fixtures'
import { getScenario } from '../scenarios'
import { delay, ulid } from '../transport'

export interface ScoringResponse extends ScoringResult {
  /** How long the decision may be reused before re-evaluation. */
  ttlSeconds: number
  evaluatedAt: string
}

export async function evaluate(): Promise<ScoringResponse> {
  await delay(90)

  if (getScenario() === 'SCORING_REVIEW') {
    return {
      score: 61,
      decision: 'REVIEW',
      reasons: ['VELOCITY_SPIKE', 'FIRST_LARGE_CRYPTO_CONVERSION'],
      caseId: `case_${ulid()}`,
      ttlSeconds: 300,
      evaluatedAt: new Date().toISOString(),
    }
  }

  return { ...SCORING, ttlSeconds: 300, evaluatedAt: new Date().toISOString() }
}
