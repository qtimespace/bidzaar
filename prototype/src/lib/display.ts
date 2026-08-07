/**
 * Asset-aware display helpers.
 *
 * The rule these encode (UX spec §13): display never rounds UP what the user
 * will receive. A summary that shows more than the ledger will pay out is a
 * support ticket at best and a complaint at worst, so every helper here rounds
 * down and delegates the arithmetic to `domain/money`.
 */

import { formatAmount } from '@/domain/money'
import type { Asset, Money } from '@/domain/types'

/**
 * How many decimals to SHOW, which is not the same as how many the asset HAS.
 * BTC carries 8 decimals but rendering "0.01420000" in a balance row reads as
 * noise; the full precision is still what gets submitted.
 */
const DISPLAY_DECIMALS: Record<string, number> = {
  RUB: 2,
  EUR: 2,
  USDT: 6,
  BTC: 8,
  ETH: 8,
}

export function displayDecimals(asset: Asset | undefined): number {
  if (!asset) return 2
  return DISPLAY_DECIMALS[asset.assetId] ?? asset.decimals
}

/** Compact form for balance rows and chips: trailing zeros trimmed, min 2 decimals. */
export function formatBalance(amount: Money, asset: Asset | undefined): string {
  if (!asset) return amount
  return formatAmount(amount, displayDecimals(asset), { trimTrailingZeros: true, minDecimals: 2 })
}

/** Exact form for the summary and the receive field: full asset precision kept. */
export function formatExact(amount: Money, asset: Asset | undefined): string {
  if (!asset) return amount
  return formatAmount(amount, asset.decimals, { trimTrailingZeros: true, minDecimals: 2 })
}

export function withSymbol(amount: string, asset: Asset | undefined): string {
  return asset ? `${amount} ${asset.assetId}` : amount
}

/** Fiat has no chain. Showing "—" is more honest than hiding the row, because a
 *  missing row makes the user wonder whether the app forgot to tell them. */
export function networkLabel(asset: Asset | undefined): string {
  if (!asset) return '—'
  if (asset.type === 'FIAT') return 'Internal ledger'
  return asset.network ?? '—'
}

const ASSET_GLYPHS: Record<string, string> = {
  RUB: '₽',
  EUR: '€',
  USDT: '₮',
  BTC: '₿',
  ETH: 'Ξ',
}

export function assetGlyph(assetId: string): string {
  return ASSET_GLYPHS[assetId] ?? assetId.slice(0, 1)
}

/** Deterministic accent per asset, so the same coin always looks the same. */
const ASSET_ACCENTS: Record<string, string> = {
  RUB: '#334155',
  EUR: '#1D4ED8',
  USDT: '#0E9F6E',
  BTC: '#F59E0B',
  ETH: '#6366F1',
}

export function assetAccent(assetId: string): string {
  return ASSET_ACCENTS[assetId] ?? '#6B7280'
}
