/**
 * The circular swap control between the two amount blocks (BRD §7).
 *
 * It sits half-overlapping both blocks so the relationship between them is
 * spatial rather than something the user has to infer from a label. The icon
 * rotates on activation — the motion is what tells the user the sides actually
 * exchanged, rather than the page having reloaded.
 */
export function SwapButton({ onSwap, disabled }: { onSwap: () => void; disabled?: boolean }) {
  return (
    <div className="swap-wrapper">
      <button
        type="button"
        className="swap-button"
        onClick={onSwap}
        disabled={disabled}
        aria-label="Swap the assets you pay and receive"
        title="Swap assets (Alt+S)"
      >
        <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <path
            d="M6 3.5v10.5M6 14l-2.75-2.75M6 14l2.75-2.75M14 16.5V6M14 6l2.75 2.75M14 6l-2.75 2.75"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  )
}
