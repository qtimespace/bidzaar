/**
 * The "You Pay" / "You Receive" block.
 *
 * One component serves both sides because they are the same object in two
 * modes; forking them would guarantee they drift apart visually. The receive
 * side is read-only (BRD §7) and carries the explanatory caption instead of the
 * balance controls.
 */

import type { ReactNode } from 'react'
import { AssetSelect, type AssetOption } from './AssetSelect'
import { InlineError } from './InlineError'
import { Skeleton } from './Skeleton'
import { formatBalance } from '@/lib/display'
import { isZero } from '@/domain/money'
import type { Asset, Balance } from '@/domain/types'

interface Props {
  id: string
  title: string
  options: AssetOption[]
  assetId: string
  onAssetChange: (assetId: string) => void
  /** Displayed value. For the pay side this is the raw text the user typed. */
  value: string
  onValueChange?: (value: string) => void
  readOnly?: boolean
  balance?: Balance
  asset?: Asset
  caption?: ReactNode
  error?: string | null
  loading?: boolean
  disabled?: boolean
  autoFocus?: boolean
  /** Announces the recalculated amount to screen readers (receive side only). */
  live?: boolean
  /** Renders the MAX button next to the balance (Design Brief, "You Pay" block). */
  onMax?: () => void
  /** Panel must stay shut while the order is being submitted (M-10). */
  forceSelectClosed?: boolean
  emptyAction?: { label: string; onClick: () => void }
}

export function AssetAmountField({
  id,
  title,
  options,
  assetId,
  onAssetChange,
  value,
  onValueChange,
  readOnly = false,
  balance,
  asset,
  caption,
  error,
  loading = false,
  disabled = false,
  autoFocus = false,
  live = false,
  onMax,
  forceSelectClosed = false,
  emptyAction,
}: Props) {
  const inputId = `${id}-amount`
  const errorId = `${id}-error`
  const labelId = `${id}-label`
  const held = balance && !isZero(balance.held) ? balance.held : null

  return (
    <section className={`amount-field${error ? ' amount-field--invalid' : ''}`}>
      <header className="amount-field__header">
        <span className="amount-field__title" id={labelId}>
          {title}
        </span>
        {balance && asset ? (
          <span className="amount-field__balance">
            {/* "Available", not "Balance": the number that governs whether the
                exchange succeeds is the spendable part, and the two differ
                whenever funds are on hold (UX spec R-07). */}
            Available: <strong>{formatBalance(balance.available, asset)}</strong> {asset.assetId}
            {held ? (
              <span className="amount-field__held">· {formatBalance(held, asset)} on hold</span>
            ) : null}
            {onMax ? (
              <button
                type="button"
                className="max-button"
                onClick={onMax}
                disabled={disabled}
                title="Use the entire available balance"
              >
                MAX
              </button>
            ) : null}
          </span>
        ) : null}
      </header>

      <div className="amount-field__row">
        <AssetSelect
          id={id}
          labelledBy={labelId}
          value={assetId}
          options={options}
          onChange={onAssetChange}
          disabled={disabled || loading}
          error={Boolean(error)}
          forceClosed={forceSelectClosed}
          emptyAction={emptyAction}
          testId={`${id}-select`}
        />

        {loading ? (
          <div className="amount-field__input amount-field__input--loading">
            <Skeleton width="60%" height="1.75rem" />
          </div>
        ) : (
          <input
            id={inputId}
            className="amount-field__input"
            // `inputMode=decimal` gives mobile the numeric keypad while keeping
            // the field a text input — `type=number` would coerce through a
            // binary float and silently mangle long crypto amounts.
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            placeholder="0"
            value={value}
            readOnly={readOnly}
            disabled={disabled}
            autoFocus={autoFocus}
            aria-labelledby={labelId}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            aria-live={live ? 'polite' : undefined}
            onChange={(event) => onValueChange?.(event.target.value)}
          />
        )}
      </div>

      {/* A <div> inside a <p> is invalid, and the caption slot carries the chip
          row on the pay side — so the wrapper is a <div> with caption styling. */}
      {error ? (
        <InlineError message={error} id={errorId} />
      ) : caption ? (
        <div className="amount-field__caption">{caption}</div>
      ) : null}
    </section>
  )
}
