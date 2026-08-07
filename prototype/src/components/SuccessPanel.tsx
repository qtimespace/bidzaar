/**
 * Confirmation after the order is created.
 *
 * BRD §4 requires the user to receive an order identifier and confirmation of
 * successful creation. Two details matter here:
 *
 * 1. The scope of this module ends at `PENDING` — the exchange is *accepted*,
 *    not *completed*. The copy says so, because "Done" over a reserved-but-
 *    unexecuted order is a lie the user will discover later.
 * 2. `MANUAL_REVIEW` is rendered as its own outcome, neither success nor
 *    failure. Painting a compliance review green would mislead; painting it red
 *    would alarm.
 */

import { formatExact } from '@/lib/display'
import type { Asset, ExchangeOrder } from '@/domain/types'

export function SuccessPanel({
  order,
  fromAsset,
  toAsset,
  onDone,
}: {
  order: ExchangeOrder
  fromAsset: Asset | undefined
  toAsset: Asset | undefined
  onDone: () => void
}) {
  const review = order.status === 'MANUAL_REVIEW'

  return (
    <div className={`success${review ? ' success--review' : ''}`} role="status">
      <div className="success__icon" aria-hidden="true">
        {review ? (
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8" />
            <path d="M12 7v5.5l3.5 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8" />
            <path d="m7.5 12.3 3 3 6-6.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>

      <h2 className="success__title">{review ? 'Sent for manual review' : 'Exchange order created'}</h2>
      <p className="success__subtitle">
        {review
          ? 'Our compliance team is checking this operation. Your funds are reserved in the meantime.'
          : 'Your funds are reserved and the order is queued for execution.'}
      </p>

      <dl className="success__details">
        <div>
          <dt>You pay</dt>
          <dd>
            {formatExact(order.fromAmount, fromAsset)} {order.fromAsset.assetId}
          </dd>
        </div>
        <div>
          <dt>You receive</dt>
          <dd>
            {formatExact(order.toAmount, toAsset)} {order.toAsset.assetId}
          </dd>
        </div>
        <div>
          <dt>Fee</dt>
          <dd>
            {formatExact(order.feeAmount, fromAsset)} {order.fromAsset.assetId}
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            <span className={`status-pill status-pill--${review ? 'review' : 'pending'}`}>{order.status}</span>
          </dd>
        </div>
        <div className="success__details-wide">
          <dt>Order ID</dt>
          <dd>
            <code>{order.orderId}</code>
          </dd>
        </div>
      </dl>

      <button type="button" className="success__action" onClick={onDone}>
        Make another exchange
      </button>
    </div>
  )
}
