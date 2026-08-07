/**
 * Exchange Summary card.
 *
 * Rows are fixed by the Design Brief — Current Rate, Fee, Estimated Receive,
 * Rate Expiration Timer, Network — plus "Total debited", which BRD §4 requires
 * and the Design Brief omits.
 *
 * `Fee` cannot be collapsed or hidden. The fee is taken out of the amount the
 * user typed rather than added on top (canonical §5.3), so without this row the
 * received amount looks like an arithmetic error rather than a priced service.
 */

import type { ReactNode } from 'react'
import { RateTimer } from './RateTimer'
import { Skeleton } from './Skeleton'
import { formatExact, networkLabel } from '@/lib/display'
import { div, formatRateLine, isZero, mul, roundHalfUp } from '@/domain/money'
import type { IndicativeRate } from '@/api/exchangeApi'
import type { NetworkInfo } from '@/api/services/cryptoProviderService'
import type { Asset, Quote } from '@/domain/types'

export function SummaryRow({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string
  value: ReactNode
  hint?: string
  emphasis?: boolean
}) {
  return (
    <div className={`summary__row${emphasis ? ' summary__row--emphasis' : ''}`}>
      <span className="summary__label">
        {label}
        {hint ? (
          <span className="summary__hint" title={hint} aria-label={hint}>
            ?
          </span>
        ) : null}
      </span>
      <span className="summary__value">{value}</span>
    </div>
  )
}

/**
 * The percentage actually charged, which is not always the schedule's headline
 * percentage. On a 500 RUB exchange the 10 RUB minimum dominates and the real
 * cost is 2 %, so printing "0.35 %" next to it would be a false disclosure.
 */
function effectiveFeePercent(quote: Quote): string {
  if (isZero(quote.fromAmount)) return quote.feePolicy.percent
  return roundHalfUp(mul(div(quote.feeAmount, quote.fromAmount), '100'), 2)
}

export function ExchangeSummary({
  quote,
  indicativeRate,
  fromAsset,
  toAsset,
  network,
  secondsLeft,
  stale,
  loading,
}: {
  quote: Quote | null
  indicativeRate: IndicativeRate | null
  fromAsset: Asset | undefined
  toAsset: Asset | undefined
  network: NetworkInfo | null
  secondsLeft: number
  stale: boolean
  loading: boolean
}) {
  if (loading) {
    return (
      <div className="summary summary--loading">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div className="summary__row" key={i}>
            <Skeleton width="90px" height="0.8rem" />
            <Skeleton width="120px" height="0.8rem" />
          </div>
        ))}
      </div>
    )
  }

  // Before an amount exists there is still a rate, and BRD §3 loads it when the
  // screen opens. Showing "—" here was the reason the screen looked like it had
  // failed to fetch anything.
  if (!quote || !fromAsset || !toAsset) {
    const rateLine =
      indicativeRate && fromAsset && toAsset
        ? formatRateLine(indicativeRate.rate, fromAsset.assetId, toAsset.assetId, 2)
        : '—'

    return (
      <div className="summary summary--empty">
        <SummaryRow label="Current Rate" value={rateLine} />
        <SummaryRow label="Fee" value={'—'} />
        <SummaryRow label="Total debited" value={'—'} />
        <SummaryRow label="Estimated Receive" value={'—'} />
        <SummaryRow label="Rate updates in" value={indicativeRate ? 'On confirmation' : '—'} />
        <SummaryRow label="Network" value={networkLabel(toAsset)} />
      </div>
    )
  }

  return (
    <div className="summary">
      <SummaryRow
        label="Current Rate"
        value={formatRateLine(quote.rate, fromAsset.assetId, toAsset.assetId, 2)}
      />
      <SummaryRow
        label="Fee"
        hint="The fee is deducted from the amount you pay, not added on top."
        value={`${formatExact(quote.feeAmount, fromAsset)} ${fromAsset.assetId} · ${effectiveFeePercent(quote)}%`}
      />
      <SummaryRow
        label="Total debited"
        value={`${formatExact(quote.fromAmount, fromAsset)} ${fromAsset.assetId}`}
      />
      <SummaryRow
        label="Estimated Receive"
        emphasis
        value={`${formatExact(quote.toAmount, toAsset)} ${toAsset.assetId}`}
      />
      <SummaryRow label="Rate updates in" value={<RateTimer secondsLeft={secondsLeft} stale={stale} />} />
      <SummaryRow
        label="Network"
        value={
          network
            ? `${networkLabel(toAsset)} · ~${Math.round(network.estimatedConfirmationSec / 60)} min`
            : networkLabel(toAsset)
        }
      />
    </div>
  )
}
