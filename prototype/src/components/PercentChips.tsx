/**
 * Quick amount selection.
 *
 * BRD §4 asks for 25/50/75/100 % and Design Brief additionally asks for MAX, so
 * both exist. They are not a duplicated control: the chips live under the input
 * as a set of proportions, while MAX sits next to the balance it refers to.
 * A user reading "Balance: 25 450 RUB" reaches for the button beside it; a user
 * thinking in fractions reaches for the row. Scenario 4 of
 * `docs/features/exchange-order.feature` treats them as two entry points with
 * one result, which is exactly what this is.
 */

const CHIPS = [25, 50, 75, 100] as const

export function PercentChips({
  onSelect,
  disabled,
  activePercent,
}: {
  onSelect: (percent: number) => void
  disabled?: boolean
  activePercent: number | null
}) {
  return (
    <div className="percent-chips" role="group" aria-label="Quick amount selection">
      {CHIPS.map((percent) => (
        <button
          key={percent}
          type="button"
          className="chip"
          onClick={() => onSelect(percent)}
          disabled={disabled}
          aria-pressed={activePercent === percent}
        >
          {percent}%
        </button>
      ))}
    </div>
  )
}
