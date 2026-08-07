/**
 * Banner shown when the rate moved while the user was deciding.
 *
 * BRD §8: the submit button is blocked until the user accepts the new terms.
 * The banner therefore carries the acceptance action itself — putting the new
 * numbers here and the button elsewhere would ask the user to remember figures
 * while their eyes travel.
 *
 * Both the old and the new receive amount are shown. Showing only the new one
 * would technically be accurate and would still hide the thing the user
 * actually wants to know: how much worse it just got.
 */

import type { RateChangeNotice } from '@/hooks/useExchangeScreen'
import { formatExact } from '@/lib/display'
import type { Asset } from '@/domain/types'

export function RateChangedBanner({
  notice,
  toAsset,
  onAccept,
}: {
  notice: RateChangeNotice
  toAsset: Asset | undefined
  onAccept: () => void
}) {
  return (
    <div className="banner banner--warning banner--rate" role="alert">
      <div className="banner__body">
        <p className="banner__title">Rate changed. Calculation updated.</p>
        <p className="banner__detail">
          You receive{' '}
          <s>
            {formatExact(notice.quotedToAmount, toAsset)} {toAsset?.assetId}
          </s>{' '}
          <strong>
            {formatExact(notice.currentToAmount, toAsset)} {toAsset?.assetId}
          </strong>
        </p>
      </div>
      <button type="button" className="banner__action" onClick={onAccept}>
        Accept
      </button>
    </div>
  )
}
