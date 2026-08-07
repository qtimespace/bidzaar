/** Loading placeholder. Sized by the caller so the layout does not jump when
 *  real content arrives — a shifting card is worse than a slow one. */
export function Skeleton({ width, height, radius }: { width?: string; height?: string; radius?: string }) {
  return (
    <span
      className="skeleton"
      aria-hidden="true"
      style={{ width: width ?? '100%', height: height ?? '1rem', borderRadius: radius ?? 'var(--radius-sm)' }}
    />
  )
}
