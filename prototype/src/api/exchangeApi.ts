/**
 * Exchange BFF / Orchestrator (mock).
 *
 * This module is the prototype's stand-in for the server side described in
 * `docs/SDD.md`. It exists so that the React layer talks to something shaped
 * exactly like the real API (`docs/api/exchange-orders.openapi.yaml`) instead of
 * reaching into fixtures directly — swapping this file for `fetch()` calls is
 * the whole migration path to a real backend.
 *
 * It implements the validation chain of `docs/00-canonical-model.md` §6 in the
 * canonical order. The order matters: it is what makes the returned error
 * deterministic when a request violates several rules at once.
 */

import {
  assertQuoteInvariants,
  calculateQuoteAmounts,
  gt,
  inverseRate,
  isValidMoney,
  isZero,
  lt,
  rateDriftPercent,
} from '@/domain/money'
import type {
  Asset,
  AssetRef,
  Balance,
  ExchangeOrder,
  KycState,
  LimitBucket,
  OrderStatus,
  PairConfig,
  Quote,
  Rate,
  Timestamp,
  UserProfile,
} from '@/domain/types'
import { ApiError } from '@/domain/errors'
import { ASSETS, DEFAULT_FROM_ASSET, DEFAULT_TO_ASSET, helpers } from './fixtures'
import { delay, fail, newCorrelationId, nowIso, uuidv4 } from './transport'
import * as accounting from './services/accountingService'
import * as crypto from './services/cryptoProviderService'
import * as kycService from './services/kycService'
import * as limitsFees from './services/limitsFeesService'
import * as notifications from './services/notificationService'
import * as orderService from './services/orderService'
import * as rates from './services/ratesService'
import * as scoring from './services/scoringService'
import * as users from './services/usersService'

/** Canonical §2 — rate lock TTL. */
export const RATE_LOCK_TTL_MS = 15_000
/** Canonical §11 — below this, a rate move is noise and is absorbed silently. */
export const RATE_DRIFT_THRESHOLD_PERCENT = 0.2

// ---------------------------------------------------------------------------
// Server-side state (in the real system: Quote Store + Idempotency Store)
// ---------------------------------------------------------------------------

const quoteStore = new Map<string, { quote: Quote; consumed: boolean }>()

/**
 * `order` is absent while the request is still in flight. Storing the entry at
 * the START of processing rather than at the end is what makes the key a real
 * lock: two concurrent requests carrying the same key would otherwise both pass
 * the lookup and both create a hold.
 */
const idempotencyStore = new Map<string, { fingerprint: string; order?: ExchangeOrder; inFlight: boolean }>()

// ---------------------------------------------------------------------------
// Bootstrap — everything the screen needs on open
// ---------------------------------------------------------------------------

export interface Bootstrap {
  user: UserProfile
  kyc: KycState
  assets: Asset[]
  balances: Balance[]
  pairs: PairConfig[]
  limits: LimitBucket[]
  defaultPair: { fromAssetId: string; toAssetId: string }
}

/**
 * Fans out to S1, S2, S4 and S6 in parallel (SDD sequence diagram 1). Serial
 * calls here would add ~300 ms to a screen whose whole promise is speed.
 */
export async function bootstrap(): Promise<Bootstrap> {
  const [user, kyc, balances, pairs, limits] = await Promise.all([
    users.getUserProfile(),
    kycService.getKycState(),
    accounting.getBalances(),
    limitsFees.getPairs(),
    limitsFees.getLimits(),
  ])

  return {
    user,
    kyc,
    assets: ASSETS,
    balances: balances.balances,
    pairs,
    limits,
    defaultPair: { fromAssetId: DEFAULT_FROM_ASSET, toAssetId: DEFAULT_TO_ASSET },
  }
}

// ---------------------------------------------------------------------------
// GET /v1/exchange/pairs/{from}/{to}/rate — indicative rate
// ---------------------------------------------------------------------------

export interface IndicativeRate {
  fromAssetId: string
  toAssetId: string
  rate: Rate
  inverseRate: Rate
  source: string
  fetchedAt: Timestamp
}

/**
 * The rate for a pair, independent of any amount.
 *
 * BRD §3 has the screen load current rates when it opens, and §4 requires the
 * user to see the current rate — neither is conditional on having typed
 * anything. Deriving the rate only from a quote made the whole summary read
 * "—" until a valid amount existed, so an amount below the pair minimum showed
 * no rate at all. That is the "rates do not load" symptom.
 *
 * This is indicative and carries no lock: it is a price tag, not a promise.
 * Only `createQuote` produces something that can be submitted.
 */
export async function getIndicativeRate(fromAssetId: string, toAssetId: string): Promise<IndicativeRate> {
  const live = await rates.getRate(fromAssetId, toAssetId)
  return {
    fromAssetId,
    toAssetId,
    rate: live.rate,
    inverseRate: inverseRate(live.rate, 2),
    source: live.source,
    fetchedAt: live.quotedAt,
  }
}

// ---------------------------------------------------------------------------
// POST /v1/exchange/quotes
// ---------------------------------------------------------------------------

export interface CreateQuoteRequest {
  fromAsset: AssetRef
  toAsset: AssetRef
  fromAmount: string
}

export interface QuoteResult {
  quote: Quote
  network: crypto.NetworkInfo | null
}

export async function createQuote(request: CreateQuoteRequest): Promise<QuoteResult> {
  const instance = '/v1/exchange/quotes'
  const { fromAsset, toAsset, fromAmount } = request

  // Steps 1, 3, 4, 5 of the chain — cheap and deterministic, run before any
  // network call so a malformed request never costs an upstream round trip.
  if (!isValidMoney(fromAmount)) {
    fail('VALIDATION_ERROR', `Amount "${fromAmount}" is not a valid decimal value`, { instance })
  }

  const from = helpers.getAsset(fromAsset.assetId)
  const to = helpers.getAsset(toAsset.assetId)
  if (!from || !to) {
    fail('ASSET_NOT_SUPPORTED', 'One of the requested assets is not available for exchange', { instance })
  }
  if (from.assetId === to.assetId && from.network === to.network) {
    fail('SAME_ASSET_PAIR', 'Source and target assets must differ', { instance })
  }

  const pair = helpers.getPair(from.assetId, to.assetId)
  if (!pair || !pair.enabled) {
    fail('PAIR_NOT_SUPPORTED', `Pair ${from.assetId}/${to.assetId} is not enabled`, {
      instance,
      params: { fromAsset: from.assetId, toAsset: to.assetId },
    })
  }

  // Zero is syntactically a valid decimal but is an input mistake, not an
  // amount below the minimum: telling someone who typed "0" that the minimum is
  // 500 RUB answers a question they did not ask. Step 1, not step 11.
  if (isZero(fromAmount)) {
    fail('VALIDATION_ERROR', 'Amount must be greater than zero', { instance })
  }

  // Steps 11, 12 — bounds. Checked before fetching a rate: there is no point
  // pricing an amount we are going to reject.
  if (lt(fromAmount, pair.minAmount)) {
    fail('AMOUNT_BELOW_MINIMUM', `Amount is below the minimum for this pair`, {
      instance,
      params: { min: pair.minAmount, asset: from.assetId },
    })
  }
  if (gt(fromAmount, pair.maxAmount)) {
    fail('AMOUNT_ABOVE_MAXIMUM', `Amount is above the maximum for this pair`, {
      instance,
      params: { max: pair.maxAmount, asset: from.assetId },
    })
  }

  const [rateQuote, networkInfo] = await Promise.all([
    rates.getRate(from.assetId, to.assetId),
    // S7 is degradable: a rejected promise here must not sink the quote.
    crypto.getNetworkInfo(to.network).catch(() => null),
  ])

  const amounts = calculateQuoteAmounts({
    rawFromAmount: fromAmount,
    rate: rateQuote.rate,
    policy: pair.feePolicy,
    fromDecimals: from.decimals,
    toDecimals: to.decimals,
  })
  assertQuoteInvariants(amounts, rateQuote.rate, {
    fromDecimals: from.decimals,
    toDecimals: to.decimals,
  })

  const quotedAt = Date.now()
  const quote: Quote = {
    quoteId: uuidv4(),
    fromAsset: { assetId: from.assetId, network: from.network },
    toAsset: { assetId: to.assetId, network: to.network },
    fromAmount: amounts.fromAmount,
    feeAmount: amounts.feeAmount,
    netFromAmount: amounts.netFromAmount,
    toAmount: amounts.toAmount,
    rate: rateQuote.rate,
    inverseRate: inverseRate(rateQuote.rate, 2),
    feePolicy: pair.feePolicy,
    rateSource: rateQuote.source,
    quotedAt: new Date(quotedAt).toISOString(),
    expiresAt: new Date(quotedAt + RATE_LOCK_TTL_MS).toISOString(),
    degraded: rateQuote.stale,
  }

  // Evict what can no longer be used. Without this the store grows by one entry
  // per keystroke for the lifetime of the session — harmless in a prototype,
  // a slow leak in the real service.
  const cutoff = quotedAt - RATE_LOCK_TTL_MS * 4
  for (const [id, entry] of quoteStore) {
    if (entry.consumed || Date.parse(entry.quote.expiresAt) < cutoff) quoteStore.delete(id)
  }

  quoteStore.set(quote.quoteId, { quote, consumed: false })
  return { quote, network: networkInfo }
}

// ---------------------------------------------------------------------------
// POST /v1/exchange-orders
// ---------------------------------------------------------------------------

export interface CreateOrderRequest {
  quoteId: string
  fromAsset: AssetRef
  toAsset: AssetRef
  fromAmount: string
  expectedToAmount: string
  expectedRate: string
  /**
   * Pre-authorises a rate move **within** the 0.20 % threshold.
   *
   * It cannot authorise more than that, by construction. A boolean cannot
   * express "how much worse am I willing to accept", so treating it as consent
   * to any rate would be consent that is not informed — the OpenAPI description
   * says so in as many words. Beyond the threshold the request always fails
   * with `RATE_CHANGED` and the user confirms a fresh quote.
   */
  acceptRateChange: boolean
  idempotencyKey: string
}

export interface CreateOrderResult {
  order: ExchangeOrder
  /** 201 for PENDING, 202 for MANUAL_REVIEW. Mirrors the OpenAPI contract. */
  httpStatus: 201 | 202
}

export async function createOrder(request: CreateOrderRequest): Promise<CreateOrderResult> {
  const instance = '/v1/exchange-orders'
  const correlationId = newCorrelationId()

  // ---- 1. Request shape -------------------------------------------------
  if (!isValidMoney(request.fromAmount) || !isValidMoney(request.expectedToAmount)) {
    fail('VALIDATION_ERROR', 'Amount fields must be valid decimal strings', { instance, correlationId })
  }

  // ---- 2. Idempotency ---------------------------------------------------
  const fingerprint = JSON.stringify({
    q: request.quoteId,
    f: request.fromAsset,
    t: request.toAsset,
    a: request.fromAmount,
  })
  const seen = idempotencyStore.get(request.idempotencyKey)
  if (seen) {
    if (seen.fingerprint !== fingerprint) {
      fail('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used with a different payload', {
        instance,
        correlationId,
      })
    }
    if (seen.order) {
      // Replay: return the original result. This is what makes a double-click,
      // a flaky connection retry and a browser back-and-resubmit all safe.
      await delay(40)
      return { order: seen.order, httpStatus: seen.order.status === 'MANUAL_REVIEW' ? 202 : 201 }
    }
    // Same key, first attempt still running. Returning a second 201 would mean
    // two holds against one intent, so the duplicate is refused outright.
    fail('IDEMPOTENCY_CONFLICT', 'A request with this idempotency key is already being processed', {
      instance,
      correlationId,
    })
  }

  // Claim the key before doing any work. Everything below must release it on
  // failure, otherwise a rejected attempt would poison every retry.
  idempotencyStore.set(request.idempotencyKey, { fingerprint, inFlight: true })
  try {
    return await processOrder(request, { instance, correlationId, fingerprint })
  } catch (error) {
    idempotencyStore.delete(request.idempotencyKey)
    throw error
  }
}

async function processOrder(
  request: CreateOrderRequest,
  ctx: { instance: string; correlationId: string; fingerprint: string },
): Promise<CreateOrderResult> {
  const { instance, correlationId, fingerprint } = ctx

  // ---- 3..5. Assets and pair -------------------------------------------
  const from = helpers.getAsset(request.fromAsset.assetId)
  const to = helpers.getAsset(request.toAsset.assetId)
  if (!from || !to) {
    fail('ASSET_NOT_SUPPORTED', 'One of the requested assets is not available', { instance, correlationId })
  }
  if (from.assetId === to.assetId && from.network === to.network) {
    fail('SAME_ASSET_PAIR', 'Source and target assets must differ', { instance, correlationId })
  }
  const pair = helpers.getPair(from.assetId, to.assetId)
  if (!pair || !pair.enabled) {
    fail('PAIR_NOT_SUPPORTED', `Pair ${from.assetId}/${to.assetId} is not enabled`, { instance, correlationId })
  }

  // ---- 6..9. Quote ------------------------------------------------------
  const entry = quoteStore.get(request.quoteId)
  if (!entry) {
    fail('QUOTE_NOT_FOUND', 'The quote does not exist or has been evicted', { instance, correlationId })
  }
  if (entry.consumed) {
    fail('QUOTE_ALREADY_USED', 'This quote has already produced an order', { instance, correlationId })
  }
  if (Date.now() >= Date.parse(entry.quote.expiresAt)) {
    fail('QUOTE_EXPIRED', 'The locked rate is no longer valid', { instance, correlationId })
  }

  const quote = entry.quote
  const matches =
    quote.fromAsset.assetId === request.fromAsset.assetId &&
    quote.toAsset.assetId === request.toAsset.assetId &&
    quote.fromAmount === request.fromAmount &&
    quote.toAmount === request.expectedToAmount &&
    quote.rate === request.expectedRate
  if (!matches) {
    fail('QUOTE_MISMATCH', 'Request parameters do not match the referenced quote', { instance, correlationId })
  }

  // ---- 10. Rate drift ---------------------------------------------------
  const liveRate = await rates.getRate(from.assetId, to.assetId)
  const drift = rateDriftPercent(quote.rate, liveRate.rate)
  let effectiveQuote = quote

  if (drift > RATE_DRIFT_THRESHOLD_PERCENT) {
    const recalculated = calculateQuoteAmounts({
      rawFromAmount: quote.fromAmount,
      rate: liveRate.rate,
      policy: pair.feePolicy,
      fromDecimals: from.decimals,
      toDecimals: to.decimals,
    })

    // Unconditional, regardless of `acceptRateChange`. There is no upper bound
    // on how far the rate may have moved, so honouring the flag here would
    // execute a trade at a price the user never saw and never bounded.
    fail('RATE_CHANGED', 'The rate moved beyond the accepted threshold while you were confirming', {
      instance,
      correlationId,
      params: {
        quotedRate: quote.rate,
        currentRate: liveRate.rate,
        quotedToAmount: quote.toAmount,
        currentToAmount: recalculated.toAmount,
        driftPercent: drift.toFixed(4),
        thresholdPercent: String(RATE_DRIFT_THRESHOLD_PERCENT),
      },
    })
  }

  if (drift > 0 && request.acceptRateChange) {
    // Inside the threshold and pre-authorised: re-price silently so the ledger
    // and the order agree with the live market rather than a stale lock.
    const recalculated = calculateQuoteAmounts({
      rawFromAmount: quote.fromAmount,
      rate: liveRate.rate,
      policy: pair.feePolicy,
      fromDecimals: from.decimals,
      toDecimals: to.decimals,
    })
    effectiveQuote = {
      ...quote,
      ...recalculated,
      rate: liveRate.rate,
      inverseRate: inverseRate(liveRate.rate, 2),
    }
  }

  // ---- 11..12. Bounds (re-checked server-side, never trusted from client) --
  if (lt(effectiveQuote.fromAmount, pair.minAmount)) {
    fail('AMOUNT_BELOW_MINIMUM', 'Amount is below the minimum for this pair', {
      instance,
      correlationId,
      params: { min: pair.minAmount, asset: from.assetId },
    })
  }
  if (gt(effectiveQuote.fromAmount, pair.maxAmount)) {
    fail('AMOUNT_ABOVE_MAXIMUM', 'Amount is above the maximum for this pair', {
      instance,
      correlationId,
      params: { max: pair.maxAmount, asset: from.assetId },
    })
  }

  // ---- 13. Account status ----------------------------------------------
  const profile = await users.getUserProfile()
  if (profile.status !== 'ACTIVE') {
    fail('USER_BLOCKED', 'The account is restricted', { instance, correlationId })
  }
  // Canonical §6 step 13 names S1 *and* S6 as sources. Checking only the account
  // status would let a wallet-level freeze through — a restriction flag exists
  // precisely because the account can be fine while the wallet is not.
  if (profile.restrictions.length > 0) {
    fail('WALLET_FROZEN', `Wallet restricted: ${profile.restrictions.join(', ')}`, { instance, correlationId })
  }

  // ---- 14..16. Compliance gate -----------------------------------------
  // Runs BEFORE the balance check on purpose (canonical §6): an unverified user
  // must not be able to probe balances or limits through error-message
  // differences.
  const kyc = await kycService.getKycState()
  if (kyc.status === 'PENDING_REVIEW' || kyc.status === 'IN_PROGRESS') {
    fail('KYC_PENDING', 'Identity verification has not finished yet', { instance, correlationId })
  }
  if (kyc.status === 'EXPIRED') {
    fail('KYC_EXPIRED', 'Identity verification has expired', { instance, correlationId })
  }
  if (kyc.status !== 'APPROVED') {
    fail('KYC_REQUIRED', 'Identity verification is required to exchange', { instance, correlationId })
  }
  if (kyc.level < kycService.MIN_KYC_LEVEL_FOR_EXCHANGE) {
    fail('KYC_LEVEL_INSUFFICIENT', 'A higher verification level is required for this operation', {
      instance,
      correlationId,
    })
  }
  // Canonical §6 step 14 says "sufficient AND not expired". An upstream that
  // returns APPROVED with a past date is exactly the case worth catching: we
  // must not rely on the provider policing its own validity window.
  if (kyc.validUntil !== null && Date.now() > Date.parse(kyc.validUntil)) {
    fail('KYC_EXPIRED', `Verification expired on ${kyc.validUntil}`, { instance, correlationId })
  }

  const limits = await limitsFees.getLimits()
  const amountInLimitCurrency = limitsFees.toLimitCurrency(from.assetId, effectiveQuote.fromAmount)
  for (const bucket of limits) {
    if (gt(amountInLimitCurrency, bucket.remaining)) {
      fail(bucket.period === 'DAILY' ? 'LIMIT_EXCEEDED_DAILY' : 'LIMIT_EXCEEDED_MONTHLY', 'Turnover limit exceeded', {
        instance,
        correlationId,
        params: { remaining: `${bucket.remaining} ${bucket.currency}`, period: bucket.period },
      })
    }
  }

  const risk = await scoring.evaluate()
  if (risk.decision === 'DENY') {
    fail('SCORING_DENIED', 'The operation was declined by risk scoring', { instance, correlationId })
  }
  const status: OrderStatus = risk.decision === 'REVIEW' ? 'MANUAL_REVIEW' : 'PENDING'

  // ---- 17. Balance ------------------------------------------------------
  const { balances } = await accounting.getBalances()
  const balance = balances.find((b) => b.assetId === from.assetId)
  if (!balance) {
    fail('ASSET_NOT_SUPPORTED', 'No wallet balance exists for the source asset', { instance, correlationId })
  }
  if (gt(effectiveQuote.fromAmount, balance.available)) {
    fail('INSUFFICIENT_FUNDS', 'Available balance is lower than the requested amount', {
      instance,
      correlationId,
      params: { available: balance.available, requested: effectiveQuote.fromAmount, asset: from.assetId },
    })
  }

  // ---- 18. Hold ---------------------------------------------------------
  let hold: accounting.HoldResponse
  try {
    hold = await accounting.createHold({
      assetId: from.assetId,
      amount: effectiveQuote.fromAmount,
      idempotencyKey: request.idempotencyKey,
    })
  } catch (error) {
    if (error instanceof ApiError) throw error
    fail('HOLD_FAILED', 'Could not reserve the funds', { instance, correlationId })
  }

  // ---- 19. Register the order, compensating the hold on failure ---------
  // This is the saga described in SDD §12: the hold and the order live in two
  // different systems, so a failure between them must not leave money frozen
  // against an order that does not exist.
  let order: ExchangeOrder
  try {
    order = await orderService.registerOrder({
      quote: effectiveQuote,
      holdId: hold.holdId,
      status,
      idempotencyKey: request.idempotencyKey,
      correlationId,
    })
  } catch (error) {
    await accounting.releaseHold(hold.holdId).catch(() => undefined)
    throw error
  }

  entry.consumed = true
  idempotencyStore.set(request.idempotencyKey, { fingerprint, order, inFlight: false })

  // S9 is non-blocking: the order is already created, so a notification failure
  // must never turn a success into an error on screen.
  notifications.notifyOrderCreated(order)

  return { order, httpStatus: status === 'MANUAL_REVIEW' ? 202 : 201 }
}

// ---------------------------------------------------------------------------
// GET /v1/exchange-orders/{orderId}
// ---------------------------------------------------------------------------

export async function getOrder(orderId: string): Promise<ExchangeOrder> {
  await delay(60)
  for (const record of idempotencyStore.values()) {
    if (record.order?.orderId === orderId) return record.order
  }
  fail('ORDER_NOT_FOUND', `Order ${orderId} does not exist or is not visible to this user`, {
    instance: `/v1/exchange-orders/${orderId}`,
  })
}

/** Test seam: clears server-side state so scenario switches start clean. */
export function resetServerState(): void {
  quoteStore.clear()
  idempotencyStore.clear()
}

export { nowIso }
