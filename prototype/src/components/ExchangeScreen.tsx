/**
 * The exchange screen.
 *
 * Everything the user needs is on one card and one confirmation — the product
 * principle from `docs/Product Context.md`. This component owns composition and
 * copy; all behaviour lives in `useExchangeScreen`, and all arithmetic in
 * `domain/money`.
 *
 * The balances strip and the scenario panel were removed at the customer's
 * request (2026-08-07): the prototype should show the exchange page, not a
 * dashboard around it. Balances now live inside the asset picker, and the
 * scenario switches moved to a URL parameter (`?scenario=RATE_DRIFT`).
 */

import { useEffect, useMemo } from 'react'
import { AssetAmountField } from './AssetAmountField'
import type { AssetOption } from './AssetSelect'
import { Banner } from './Banner'
import { ExchangeSummary } from './ExchangeSummary'
import { PercentChips } from './PercentChips'
import { RateChangedBanner } from './RateChangedBanner'
import { SubmitButton } from './SubmitButton'
import { SuccessPanel } from './SuccessPanel'
import { SwapButton } from './SwapButton'
import { useExchangeScreen } from '@/hooks/useExchangeScreen'
import { eq, percentOfBalance, sanitizeInput } from '@/domain/money'
import { formatExact } from '@/lib/display'

export function ExchangeScreen() {
  const model = useExchangeScreen()
  const {
    phase,
    assets,
    balances,
    pairs,
    input,
    quote,
    indicativeRate,
    network,
    fieldIssue,
    selectIssue,
    bannerIssue,
    rateChange,
    order,
    secondsLeft,
    fromAsset,
    toAsset,
    fromBalance,
    canSubmit,
    actions,
  } = model

  const booting = phase === 'INITIALIZING' || phase === 'LOADING_DATA'
  const quoting = phase === 'QUOTING'
  const submitting = phase === 'SUBMITTING'
  const finished = phase === 'SUCCESS' || phase === 'MANUAL_REVIEW'

  const balanceOf = useMemo(
    () => (assetId: string) => balances.find((b) => b.assetId === assetId),
    [balances],
  )

  /** Options for the "You Pay" picker: every asset, each with its balance. */
  const payOptions: AssetOption[] = useMemo(
    () =>
      assets.map((asset) => ({
        asset,
        balance: balanceOf(asset.assetId),
        disabled: asset.assetId === model.toAssetId,
        disabledReason: asset.assetId === model.toAssetId ? 'Already selected as receive' : undefined,
      })),
    [assets, balanceOf, model.toAssetId],
  )

  /**
   * Receive options are additionally gated on the pair being supported. An
   * unsupported pair used to be selectable and then failed validation; naming
   * the reason in the list is cheaper for the user than an error afterwards.
   */
  const receiveOptions: AssetOption[] = useMemo(
    () =>
      assets.map((asset) => {
        const same = asset.assetId === model.fromAssetId
        const supported = pairs.some(
          (p) => p.fromAssetId === model.fromAssetId && p.toAssetId === asset.assetId && p.enabled,
        )
        return {
          asset,
          balance: balanceOf(asset.assetId),
          disabled: same || !supported,
          disabledReason: same ? 'Already selected as pay' : !supported ? 'Pair not available' : undefined,
        }
      }),
    [assets, balanceOf, model.fromAssetId, pairs],
  )

  /** Escape hatch when every receive option is unavailable (from = EUR). */
  const emptyAction = useMemo(
    () => ({ label: 'Switch to RUB → USDT', onClick: () => actions.reset() }),
    [actions],
  )

  /** Which quick-select chip, if any, matches the current amount exactly. */
  const activePercent = useMemo(() => {
    if (!fromAsset || !fromBalance || input === '') return null
    const value = sanitizeInput(input)
    for (const percent of [25, 50, 75, 100]) {
      const candidate = percentOfBalance(fromBalance.available, percent, fromAsset.decimals)
      try {
        if (eq(value, candidate)) return percent
      } catch {
        return null
      }
    }
    return null
  }, [input, fromAsset, fromBalance])

  /** Why the primary button is unavailable. Ordered by what the user can act on. */
  const disabledReason = useMemo(() => {
    if (canSubmit || submitting || finished) return null
    if (phase === 'RATE_CHANGED_PENDING_ACCEPT') return 'Accept the updated rate to continue'
    if (selectIssue) return selectIssue.message
    if (fieldIssue) return fieldIssue.message
    if (input === '') return 'Enter an amount to exchange'
    if (quoting) return 'Calculating the current rate…'
    if (phase === 'QUOTE_STALE') return 'The quote is paused. Edit the amount to refresh it.'
    if (bannerIssue) return bannerIssue.message
    return 'Waiting for a current rate'
  }, [canSubmit, submitting, finished, phase, selectIssue, fieldIssue, input, quoting, bannerIssue])

  // Keyboard affordances (UX spec §15). Enter submits from anywhere on the card,
  // which matters on mobile where the virtual keyboard hides the button.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The asset picker owns these keys while it is open.
      const target = event.target as HTMLElement | null
      if (target?.closest('.asset-select')) return

      if (event.key === 'Enter' && canSubmit) {
        event.preventDefault()
        void actions.submit()
      }
      if (event.key === 'Escape' && !finished && !submitting) {
        actions.reset()
      }
      if (event.altKey && (event.key === 's' || event.key === 'S')) {
        event.preventDefault()
        actions.swap()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canSubmit, finished, submitting, actions])

  const receiveValue = quote && toAsset ? formatExact(quote.toAmount, toAsset) : ''

  return (
    <main className="card" aria-labelledby="exchange-title">
      <header className="card__header">
        <h1 className="card__title" id="exchange-title">
          Exchange
        </h1>
        <p className="card__subtitle">Convert one currency into another instantly.</p>
      </header>

      {finished && order ? (
        <SuccessPanel order={order} fromAsset={fromAsset} toAsset={toAsset} onDone={actions.reset} />
      ) : (
        <>
          <AssetAmountField
            id="pay"
            title="You Pay"
            options={payOptions}
            assetId={model.fromAssetId}
            onAssetChange={actions.setFromAsset}
            value={input}
            onValueChange={actions.setInput}
            balance={fromBalance}
            asset={fromAsset}
            error={fieldIssue?.message ?? selectIssue?.message ?? null}
            loading={booting}
            disabled={submitting}
            forceSelectClosed={submitting}
            autoFocus
            onMax={() => actions.applyPercent(100)}
            caption={
              <PercentChips
                onSelect={actions.applyPercent}
                disabled={booting || submitting || !fromBalance}
                activePercent={activePercent}
              />
            }
          />

          <SwapButton onSwap={actions.swap} disabled={booting || submitting} />

          <AssetAmountField
            id="receive"
            title="You Receive"
            options={receiveOptions}
            assetId={model.toAssetId}
            onAssetChange={actions.setToAsset}
            value={quoting ? '' : receiveValue}
            readOnly
            asset={toAsset}
            balance={model.toBalance}
            loading={booting || quoting}
            disabled={submitting}
            forceSelectClosed={submitting}
            emptyAction={emptyAction}
            live
            caption="Calculated automatically using the current exchange rate."
          />

          <ExchangeSummary
            quote={quote}
            indicativeRate={indicativeRate}
            fromAsset={fromAsset}
            toAsset={toAsset}
            network={network}
            secondsLeft={secondsLeft}
            stale={phase === 'QUOTE_STALE'}
            loading={booting}
          />

          {rateChange ? (
            <RateChangedBanner notice={rateChange} toAsset={toAsset} onAccept={actions.acceptRateChange} />
          ) : bannerIssue ? (
            <Banner issue={bannerIssue} onRetry={bannerIssue.retryable ? actions.retry : undefined} />
          ) : null}

          <SubmitButton
            onClick={() => void actions.submit()}
            disabled={!canSubmit}
            loading={submitting}
            reason={disabledReason}
          />

          <p className="legal">
            The rate is locked for 15 seconds. The fee is deducted from the amount you pay. Creating an
            order reserves your funds; execution is confirmed separately.
          </p>
        </>
      )}
    </main>
  )
}
