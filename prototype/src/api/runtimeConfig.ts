/**
 * Runtime knobs read from the URL.
 *
 * The prototype has no backend and no settings screen, so demo behaviour is
 * steered by query parameters. They are read lazily on every call rather than
 * cached at module load, which is what lets a test change the URL between
 * assertions.
 *
 * | Parameter        | Default | Meaning                                        |
 * |------------------|---------|------------------------------------------------|
 * | `scenario`       | `HAPPY` | Failure scenario, see canonical §10.6           |
 * | `rateTick`       | `on`    | `off` freezes the market simulation             |
 * | `rateTickMs`     | `15000` | Length of one market window                     |
 * | `rateTickFactor` | `0.9995`| Coefficient applied once per elapsed window     |
 */

/**
 * How much the rate moves per window. Applied as `factor ^ windowsElapsed`.
 *
 * −0.05 % per window is deliberately **below** the 0.20 % interruption
 * threshold of canonical §11. A larger coefficient would make every single
 * quote expiry demand an explicit "accept the new rate", which contradicts the
 * product promise of an exchange in a few seconds (BRD §2) and would turn the
 * safety mechanism into noise the user learns to click through.
 *
 * The above-threshold case is still reachable, and on purpose: it is
 * `?scenario=RATE_DRIFT`, where the move is −0.53 % and acceptance is required.
 * Raise `?rateTickFactor=0.99` to see the same behaviour on the normal path.
 */
const DEFAULT_RATE_TICK_FACTOR = '0.9995'

/** Mirrors the rate lock TTL from canonical §2: the market moves exactly when
 *  the lock expires, so every auto-refresh shows a genuinely new price. */
const DEFAULT_RATE_TICK_PERIOD_MS = 15_000

/** Guard against absurd compounding on a tab left open overnight. */
const MAX_TICK_WINDOWS = 400

const DECIMAL_PATTERN = /^(0|[1-9]\d{0,3})(\.\d{1,18})?$/

function params(): URLSearchParams | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search)
}

export function isRateTickEnabled(): boolean {
  return params()?.get('rateTick')?.toLowerCase() !== 'off'
}

export function rateTickPeriodMs(): number {
  const raw = params()?.get('rateTickMs')
  const parsed = raw === null || raw === undefined ? NaN : Number(raw)
  // Not money, so a plain number is fine here — but a nonsensical value must
  // not turn into a division by zero or a negative window.
  return Number.isFinite(parsed) && parsed >= 50 ? parsed : DEFAULT_RATE_TICK_PERIOD_MS
}

export function rateTickFactor(): string {
  const raw = params()?.get('rateTickFactor')
  return raw && DECIMAL_PATTERN.test(raw) ? raw : DEFAULT_RATE_TICK_FACTOR
}

/** Number of complete market windows since `since`, clamped. */
export function elapsedTickWindows(since: number, now: number): number {
  if (!isRateTickEnabled()) return 0
  const windows = Math.floor((now - since) / rateTickPeriodMs())
  if (!Number.isFinite(windows) || windows <= 0) return 0
  return Math.min(windows, MAX_TICK_WINDOWS)
}
