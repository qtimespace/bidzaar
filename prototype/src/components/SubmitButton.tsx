/**
 * Primary action (BRD §7: full width, ~48 px, saturated blue, grey when
 * unavailable).
 *
 * The button carries a `reason` when disabled and exposes it via `title` and an
 * adjacent live region. A grey button with no explanation is the most common
 * dead end in a form: the user can see they are blocked but not by what.
 */

export function SubmitButton({
  onClick,
  disabled,
  loading,
  reason,
  label = 'Exchange Now',
}: {
  onClick: () => void
  disabled: boolean
  loading: boolean
  reason?: string | null
  label?: string
}) {
  return (
    <div className="submit">
      <button
        type="button"
        className="submit__button"
        onClick={onClick}
        disabled={disabled || loading}
        title={disabled && reason ? reason : undefined}
        aria-busy={loading}
      >
        {loading ? (
          <>
            <span className="spinner" aria-hidden="true" />
            Creating order…
          </>
        ) : (
          label
        )}
      </button>
      <p className="submit__reason" aria-live="polite">
        {disabled && !loading && reason ? reason : ''}
      </p>
    </div>
  )
}
