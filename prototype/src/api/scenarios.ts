/**
 * Scenario switches.
 *
 * Canonical §10.6. The prototype has no backend, so the only way to reach a
 * negative path is to inject it. Each key maps one-to-one to a scenario in
 * `docs/features/exchange-order.feature`, which is what makes the prototype a
 * demonstrable artefact rather than a happy-path screenshot.
 */

export const SCENARIOS = {
  HAPPY: 'HAPPY',
  RATE_DRIFT: 'RATE_DRIFT',
  RATES_DOWN: 'RATES_DOWN',
  EXCHANGE_DOWN: 'EXCHANGE_DOWN',
  KYC_PENDING: 'KYC_PENDING',
  LIMIT_HIT: 'LIMIT_HIT',
  SCORING_REVIEW: 'SCORING_REVIEW',
  SLOW_NETWORK: 'SLOW_NETWORK',
} as const

export type ScenarioKey = keyof typeof SCENARIOS

export interface ScenarioMeta {
  key: ScenarioKey
  label: string
  /** What the tester should expect to see. Rendered in the dev panel. */
  expectation: string
}

export const SCENARIO_LIST: ScenarioMeta[] = [
  { key: 'HAPPY', label: 'Happy path', expectation: 'Order is created, status PENDING' },
  { key: 'RATE_DRIFT', label: 'Rate drifts mid-entry', expectation: 'Banner "Rate changed", submit blocked until accepted' },
  { key: 'RATES_DOWN', label: 'Rate service down', expectation: 'Quote fails with RATE_SERVICE_UNAVAILABLE' },
  { key: 'EXCHANGE_DOWN', label: 'Exchange service down', expectation: 'Submit fails with EXCHANGE_SERVICE_UNAVAILABLE' },
  { key: 'KYC_PENDING', label: 'Verification in progress', expectation: 'Submit blocked with KYC_PENDING' },
  { key: 'LIMIT_HIT', label: 'Daily limit almost used', expectation: 'Large amount fails with LIMIT_EXCEEDED_DAILY' },
  { key: 'SCORING_REVIEW', label: 'Scoring requires review', expectation: 'Order accepted with status MANUAL_REVIEW' },
  { key: 'SLOW_NETWORK', label: 'Slow network (2.5 s)', expectation: 'Skeletons and button loading state stay visible' },
]

let current: ScenarioKey = 'HAPPY'
let activatedAt = Date.now()

const listeners = new Set<(key: ScenarioKey) => void>()

export function getScenario(): ScenarioKey {
  return current
}

/** When the current scenario was selected. Time-based scenarios (RATE_DRIFT)
 *  measure from here so switching scenarios restarts them cleanly. */
export function getScenarioActivatedAt(): number {
  return activatedAt
}

export function setScenario(key: ScenarioKey): void {
  current = key
  activatedAt = Date.now()
  listeners.forEach((fn) => fn(key))
}

export function subscribeScenario(fn: (key: ScenarioKey) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
