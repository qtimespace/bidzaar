/**
 * Inline validation message, rendered directly under the offending control.
 *
 * BRD §8 is explicit: ordinary validation must not use modals. `role="alert"`
 * makes the message reach screen readers at the same moment it reaches everyone
 * else.
 */
export function InlineError({ message, id }: { message: string; id?: string }) {
  return (
    <p className="inline-error" id={id} role="alert">
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 4.5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="8" cy="11" r="0.9" fill="currentColor" />
      </svg>
      {message}
    </p>
  )
}
