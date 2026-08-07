/**
 * Asset selector — a custom combobox showing each asset with its balance.
 *
 * Specified in `docs/UX-UI-Spec.md` §22. It replaces a native `<select>`, which
 * means the four things the platform used to provide for free — keyboard
 * navigation, type-ahead, focus management and the mobile picker — are now our
 * responsibility. That is the whole reason this file is as long as it is; read
 * §22.3–22.4 before changing any of it.
 *
 * Below 480 px the list becomes a bottom sheet: an anchored dropdown loses to
 * the on-screen keyboard and lands outside thumb reach (§22.4).
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { assetAccent, assetGlyph, formatBalance } from '@/lib/display'
import { isZero } from '@/domain/money'
import type { Asset, Balance } from '@/domain/types'

export interface AssetOption {
  asset: Asset
  /** Undefined leaves the balance column empty rather than printing a false "0.00". */
  balance?: Balance
  disabled?: boolean
  disabledReason?: string
}

export interface AssetSelectProps {
  id: string
  /** id of the visible block label, e.g. the "You Pay" heading. */
  labelledBy: string
  value: string
  options: AssetOption[]
  /** Fires only on commit, and only when the value actually changes. */
  onChange: (assetId: string) => void
  disabled?: boolean
  error?: boolean
  /** Shown in the panel footer when every option is unavailable (EUR → *). */
  emptyAction?: { label: string; onClick: () => void }
  /** Forces the panel shut — used while submitting (invariant M-10). */
  forceClosed?: boolean
  presentation?: 'auto' | 'dropdown' | 'sheet'
  testId?: string
}

const MOBILE_QUERY = '(max-width: 480px)'
const TYPE_AHEAD_MS = 700
const PAGE_STEP = 5

function useIsMobile(presentation: 'auto' | 'dropdown' | 'sheet') {
  const [mobile, setMobile] = useState(false)

  useEffect(() => {
    if (presentation !== 'auto') return
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(MOBILE_QUERY)
    const apply = () => setMobile(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [presentation])

  if (presentation === 'sheet') return true
  if (presentation === 'dropdown') return false
  return mobile
}

export function AssetSelect({
  id,
  labelledBy,
  value,
  options,
  onChange,
  disabled = false,
  error = false,
  emptyAction,
  forceClosed = false,
  presentation = 'auto',
  testId,
}: AssetSelectProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [flipUp, setFlipUp] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const typeAhead = useRef<{ buffer: string; at: number }>({ buffer: '', at: 0 })

  const isMobile = useIsMobile(presentation)
  const reactId = useId()
  const listId = `${id}-listbox-${reactId}`
  const optionId = (index: number) => `${id}-option-${index}-${reactId}`

  const selected = useMemo(() => options.find((o) => o.asset.assetId === value), [options, value])
  const selectedIndex = useMemo(() => options.findIndex((o) => o.asset.assetId === value), [options, value])
  const allDisabled = options.every((o) => o.disabled)

  const close = useCallback(
    (returnFocus: boolean) => {
      setOpen(false)
      setActiveIndex(-1)
      if (returnFocus) triggerRef.current?.focus()
    },
    [],
  )

  // Invariant M-10: the panel must not survive into a submitting screen.
  useEffect(() => {
    if (forceClosed && open) close(false)
  }, [forceClosed, open, close])

  // A dropdown and a sheet are different trees; crossing the breakpoint while
  // open would move the list out from under the pointer.
  useEffect(() => {
    if (open) close(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile])

  /** Next selectable index in `direction`, clipped at the edges — no wrapping.
   *  Wrapping hides where the list ends and, on a held arrow key, lands the
   *  user on an asset they did not mean to pick (§22.2). */
  const step = useCallback(
    (from: number, direction: 1 | -1): number => {
      let i = from
      for (;;) {
        i += direction
        if (i < 0 || i >= options.length) return from < 0 ? firstEnabled(direction) : from
        if (!options[i].disabled) return i
      }
      function firstEnabled(dir: 1 | -1) {
        const order = dir === 1 ? options.map((_, k) => k) : options.map((_, k) => options.length - 1 - k)
        return order.find((k) => !options[k].disabled) ?? -1
      }
    },
    [options],
  )

  const edge = useCallback(
    (which: 'first' | 'last'): number => {
      const order = which === 'first' ? options.map((_, k) => k) : options.map((_, k) => options.length - 1 - k)
      return order.find((k) => !options[k].disabled) ?? -1
    },
    [options],
  )

  const openPanel = useCallback(
    (initial?: number) => {
      if (disabled) return
      setOpen(true)
      setActiveIndex(initial ?? (selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : edge('first')))
    },
    [disabled, selectedIndex, options, edge],
  )

  const commit = useCallback(
    (index: number) => {
      const option = options[index]
      if (!option || option.disabled) return
      if (option.asset.assetId !== value) onChange(option.asset.assetId)
      close(true)
    },
    [options, value, onChange, close],
  )

  // Close on outside interaction. Focus is deliberately not returned here — the
  // user is already looking somewhere else.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
    }
  }, [open, close])

  // Flip the panel above the trigger when there is no room below.
  useLayoutEffect(() => {
    if (!open || isMobile) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setFlipUp(window.innerHeight - rect.bottom < 340 && rect.top > 340)
  }, [open, isMobile])

  useEffect(() => {
    if (!open || activeIndex < 0) return
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIndex])

  useEffect(() => {
    if (open && isMobile) listRef.current?.focus()
  }, [open, isMobile])

  const onKeyDown = (event: React.KeyboardEvent) => {
    const { key, altKey } = event

    if (!open) {
      if (key === 'Enter' || key === ' ' || (key === 'ArrowDown' && altKey)) {
        event.preventDefault()
        openPanel()
        return
      }
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault()
        openPanel(step(selectedIndex, key === 'ArrowDown' ? 1 : -1))
        return
      }
      if (key === 'Home' || key === 'End') {
        event.preventDefault()
        openPanel(edge(key === 'Home' ? 'first' : 'last'))
        return
      }
      if (key.length === 1 && /[a-z0-9]/i.test(key)) {
        event.preventDefault()
        openPanel(matchTypeAhead(key, -1))
        return
      }
      return
    }

    switch (key) {
      case 'Escape':
        event.preventDefault()
        close(true)
        return
      case 'Tab':
        close(false)
        return
      case 'Enter':
      case ' ':
        event.preventDefault()
        commit(activeIndex)
        return
      case 'ArrowUp':
        event.preventDefault()
        if (altKey) close(true)
        else setActiveIndex((i) => step(i, -1))
        return
      case 'ArrowDown':
        event.preventDefault()
        setActiveIndex((i) => step(i, 1))
        return
      case 'Home':
        event.preventDefault()
        setActiveIndex(edge('first'))
        return
      case 'End':
        event.preventDefault()
        setActiveIndex(edge('last'))
        return
      case 'PageDown':
      case 'PageUp': {
        event.preventDefault()
        const direction = key === 'PageDown' ? 1 : -1
        setActiveIndex((i) => {
          let next = i
          for (let n = 0; n < PAGE_STEP; n++) next = step(next, direction)
          return next
        })
        return
      }
      default:
        if (key.length === 1 && /[a-z0-9]/i.test(key)) {
          event.preventDefault()
          setActiveIndex((i) => matchTypeAhead(key, i))
        }
    }
  }

  /** Type-ahead over the ticker. Repeating the same letter cycles through the
   *  matches, which is how USDT@TRON and USDT@ETHEREUM stay reachable. */
  function matchTypeAhead(char: string, from: number): number {
    const now = Date.now()
    const fresh = now - typeAhead.current.at > TYPE_AHEAD_MS
    const buffer = fresh ? char : typeAhead.current.buffer + char
    typeAhead.current = { buffer, at: now }

    const repeated = buffer.length > 1 && buffer.split('').every((c) => c === buffer[0])
    const needle = (repeated ? buffer[0] : buffer).toUpperCase()
    const start = repeated || fresh ? from + 1 : 0

    for (let n = 0; n < options.length; n++) {
      const i = (start + n + options.length) % options.length
      const option = options[i]
      if (option.disabled) continue
      if (option.asset.assetId.toUpperCase().startsWith(needle)) return i
    }
    return from
  }

  const rows = options.map((option, index) => {
    const { asset, balance } = option
    const isSelected = asset.assetId === value
    const isActive = index === activeIndex
    const empty = balance ? isZero(balance.available) : false
    const held = balance && !isZero(balance.held) ? balance.held : null

    return (
      <li
        key={`${asset.assetId}-${asset.network ?? 'fiat'}`}
        id={optionId(index)}
        role="option"
        aria-selected={isSelected}
        aria-disabled={option.disabled || undefined}
        data-testid={`asset-option-${asset.assetId}`}
        className={[
          'asset-select__option',
          isActive ? 'asset-select__option--active' : '',
          empty ? 'asset-select__option--empty' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onMouseEnter={() => !option.disabled && setActiveIndex(index)}
        onClick={() => commit(index)}
      >
        <span className="asset-select__glyph" style={{ background: assetAccent(asset.assetId) }} aria-hidden="true">
          {assetGlyph(asset.assetId)}
        </span>

        <span className="asset-select__option-name">
          <span className="asset-select__option-primary">
            {asset.assetId}
            {asset.network ? ` · ${asset.network}` : ''}
            {isSelected ? (
              <svg className="asset-select__check" viewBox="0 0 16 16" aria-hidden="true">
                <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : null}
          </span>
          <span className="asset-select__option-secondary">
            {option.disabled ? (option.disabledReason ?? 'Not available') : asset.displayName}
          </span>
        </span>

        <span className="asset-select__option-meta">
          {balance ? (
            <>
              <span className="asset-select__option-balance">{formatBalance(balance.available, asset)}</span>
              {held ? (
                <span className="asset-select__option-held">{formatBalance(held, asset)} on hold</span>
              ) : empty ? (
                <span className="asset-select__option-note">No funds</span>
              ) : null}
            </>
          ) : null}
        </span>
      </li>
    )
  })

  const list = (
    <ul
      ref={listRef}
      id={listId}
      role="listbox"
      tabIndex={isMobile ? -1 : undefined}
      aria-labelledby={labelledBy}
      aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
      className={
        isMobile
          ? 'asset-select__sheet'
          : `asset-select__panel${flipUp ? ' asset-select__panel--above' : ''}`
      }
      onKeyDown={isMobile ? onKeyDown : undefined}
      data-testid={`${id}-listbox`}
    >
      {isMobile ? <li className="asset-select__handle" aria-hidden="true" /> : null}
      {rows}
      {allDisabled && emptyAction ? (
        <li className="asset-select__footer">
          <button
            type="button"
            onClick={() => {
              emptyAction.onClick()
              close(true)
            }}
          >
            {emptyAction.label}
          </button>
        </li>
      ) : null}
    </ul>
  )

  return (
    <div
      ref={rootRef}
      className={`asset-select${error ? ' asset-select--error' : ''}`}
      onKeyDown={isMobile && open ? undefined : onKeyDown}
      data-testid={testId}
    >
      <button
        ref={triggerRef}
        type="button"
        className="asset-select__trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && activeIndex >= 0 && !isMobile ? optionId(activeIndex) : undefined}
        aria-labelledby={labelledBy}
        disabled={disabled}
        onClick={() => (open ? close(true) : openPanel())}
      >
        <span
          className="asset-select__glyph"
          style={{ background: assetAccent(value) }}
          aria-hidden="true"
        >
          {assetGlyph(value)}
        </span>
        <span className="asset-select__label">
          <span className="asset-select__ticker">{value}</span>
          {selected?.asset.network ? (
            <span className="asset-select__network">{selected.asset.network}</span>
          ) : null}
        </span>
        <svg className="asset-select__caret" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open && isMobile ? (
        <>
          <div className="asset-select__overlay" onClick={() => close(true)} aria-hidden="true" />
          {list}
        </>
      ) : null}
      {open && !isMobile ? list : null}
    </div>
  )
}
