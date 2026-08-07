/**
 * Generic banner for service-level problems (503, KYC, scoring, limits).
 *
 * Field-level problems never come here — BRD §8 puts those next to the control
 * that caused them. This is for conditions the user cannot fix by editing the
 * form.
 */

import type { BannerIssue } from '@/hooks/useExchangeScreen'

export function Banner({ issue, onRetry }: { issue: BannerIssue; onRetry?: () => void }) {
  return (
    <div className={`banner banner--${issue.tone}`} role="alert">
      <div className="banner__body">
        <p className="banner__title">{issue.message}</p>
        <p className="banner__detail banner__detail--code">{issue.code}</p>
      </div>
      {issue.retryable && onRetry ? (
        <button type="button" className="banner__action" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  )
}
