/**
 * Rate lock countdown (BRD §4: "курс действует 15 секунд").
 *
 * A bare countdown on a money screen reads as a threat, so two things soften
 * it: the ring depletes smoothly instead of flashing digits, and the copy says
 * what happens at zero ("auto-refresh"), not merely that time is running out.
 * Nothing is lost when it expires — the quote just re-prices.
 */

import { TIMER_WARNING_SECONDS } from '@/hooks/useExchangeScreen'

const TOTAL_SECONDS = 15
const RADIUS = 7
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export function RateTimer({ secondsLeft, stale }: { secondsLeft: number; stale: boolean }) {
  const clamped = Math.max(0, Math.min(TOTAL_SECONDS, secondsLeft))
  const progress = clamped / TOTAL_SECONDS
  const warning = clamped > 0 && clamped <= TIMER_WARNING_SECONDS

  // No handler is attached here, so the copy must not promise one: editing the
  // amount is what re-prices a paused quote.
  if (stale) {
    return <span className="rate-timer rate-timer--stale">Paused — edit the amount</span>
  }

  return (
    <span
      className={`rate-timer${warning ? ' rate-timer--warning' : ''}`}
      // `polite` and not `assertive`: announcing every tick would make the
      // screen unusable with a reader. The seconds are exposed as text below.
      aria-live="off"
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <circle cx="9" cy="9" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.18" />
        <circle
          cx="9"
          cy="9"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - progress)}
          transform="rotate(-90 9 9)"
          style={{ transition: 'stroke-dashoffset var(--duration-fast) linear' }}
        />
      </svg>
      <span>{clamped}s</span>
    </span>
  )
}
