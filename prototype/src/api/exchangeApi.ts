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
  adverseRateDriftPercent,
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
  QuoteSide,
  Rate,
  Timestamp,
  UserProfile,
} from '@/domain/types'
import { ApiError, LIMIT_CODE_BY_PERIOD } from '@/domain/errors'
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
/**
 * Canonical §11 — fallback drift threshold, in percent.
 *
 * Decision O-8 made the threshold a property of the PAIR, supplied by S4. This
 * constant is now only the fallback for a pair that carries no value of its
 * own: an unknown threshold must not be treated as infinite, and an exchange
 * must not be blocked over a parameter that has a safe default. Read the
 * effective value through `driftThresholdFor(pair)`, never directly.
 */
export const DEFAULT_RATE_DRIFT_THRESHOLD_PERCENT = 0.2

/**
 * Effective drift threshold for a pair, in percent.
 *
 * Falling back is a degraded state, not a normal one: the caller marks the
 * quote `degraded` so a broken S4 integration cannot hide behind behaviour that
 * looks entirely normal.
 */
export function driftThresholdFor(pair: Pick<PairConfig, 'driftThresholdPercent'>): number {
  const configured = pair.driftThresholdPercent
  if (configured === undefined) return DEFAULT_RATE_DRIFT_THRESHOLD_PERCENT
  const parsed = Number(configured)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RATE_DRIFT_THRESHOLD_PERCENT
}

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
  /**
   * Which side the caller is fixing (decision O-9). Optional and defaulting to
   * `SELL`, which is exactly the previous behaviour — that is what keeps the
   * change compatible for callers written before it existed.
   */
  side?: QuoteSide
  /** Required when side is SELL, forbidden when side is BUY. */
  fromAmount?: string
  /** Required when side is BUY, forbidden when side is SELL. */
  toAmount?: string
}

export interface QuoteResult {
  quote: Quote
  network: crypto.NetworkInfo | null
}

export async function createQuote(request: CreateQuoteRequest): Promise<QuoteResult> {
  const instance = '/v1/exchange/quotes'
  const { fromAsset, toAsset } = request
  const side: QuoteSide = request.side ?? 'SELL'

  // ---- Step 1: exactly one amount, on the side the request declares --------
  if (side === 'BUY') {
    if (request.fromAmount !== undefined) {
      fail('VALIDATION_ERROR', 'fromAmount must not be sent when side is BUY', {
        instance,
        params: { field: '/fromAmount', reason: 'NOT_ALLOWED_FOR_SIDE' },
      })
    }
    if (request.toAmount === undefined) {
      fail('VALIDATION_ERROR', 'toAmount is required when side is BUY', {
        instance,
        params: { field: '/toAmount', reason: 'REQUIRED' },
      })
    }
    // The contract defines the reverse calculation; this prototype does not
    // implement it. Canonical §5.4 makes it a search, not a formula: minFee and
    // maxFee split the equation into branches, so every candidate has to be
    // verified by a forward pass. A hurried approximation here would round the
    // derived debit the wrong way and quietly break invariant I2 — a stub that
    // states its own absence is the honest option until the UI needs the mode.
    fail('VALIDATION_ERROR', 'Reverse calculation (side=BUY) is defined by the contract but not implemented in this prototype', {
      instance,
      params: { field: '/side', reason: 'NOT_IMPLEMENTED_IN_PROTOTYPE' },
    })
  }

  if (request.toAmount !== undefined) {
    fail('VALIDATION_ERROR', 'toAmount must not be sent when side is SELL', {
      instance,
      params: { field: '/toAmount', reason: 'NOT_ALLOWED_FOR_SIDE' },
    })
  }
  const fromAmount = request.fromAmount
  if (fromAmount === undefined) {
    fail('VALIDATION_ERROR', 'fromAmount is required when side is SELL', {
      instance,
      params: { field: '/fromAmount', reason: 'REQUIRED' },
    })
  }

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
    side,
    // SELL fixes the debit side, so the requested amount IS fromAmount. Stored
    // explicitly rather than inferred, because under BUY the two differ and a
    // reader must not have to know the side to interpret the field.
    requestedAmount: fromAmount,
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
    // A pair with no threshold of its own means S4 did not supply one and the
    // default was applied — decision O-8 requires that to be visible rather
    // than silently normal.
    degraded: rateQuote.stale || pair.driftThresholdPercent === undefined,
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
   * "Do not credit me less than X" — the lower bound on the credited amount,
   * in the target asset (decision O-16).
   *
   * Consent is expressed as an AMOUNT, not a rate, and not a boolean. A boolean
   * cannot say how much worse the user will accept; a rate bound is a trap,
   * because in the canonical direction a worse deal means a SMALLER rate, so
   * the guard is a lower bound while the obvious name reads as an upper one.
   * The user decides on the sum they see, so that is the unit the contract
   * takes. Valid only for a SELL-side quote, where the credit is derived.
   */
  minAcceptableToAmount?: string
  /**
   * "Do not debit me more than Y" — the upper bound on the debited amount, in
   * the source asset. The mirror of the above, valid only for a BUY-side quote.
   * Unreachable in this prototype while side=BUY is not implemented, but the
   * field exists so the shape matches the contract.
   */
  maxAcceptableFromAmount?: string
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
    fail('REQUEST_IN_PROGRESS', 'A request with this idempotency key is already being processed', {
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
  // Consent is evaluated on the recalculated AMOUNT, never on the rate or on a
  // flag (decision O-16): "less was credited" is a comparison nobody can get
  // backwards, whereas the direction of a rate bound depends on which way the
  // pair is written.
  const liveRate = await rates.getRate(from.assetId, to.assetId)
  const threshold = driftThresholdFor(pair)
  // One-sided by design (decision O-18): only a move AGAINST the system can
  // make the locked quote untenable. A favourable move is honoured at the
  // locked rate like any other, the user receives exactly the sum they
  // confirmed, and the difference stays with the system — that is what fixing
  // a price means. Interrupting there would be noise.
  const adverseDrift = adverseRateDriftPercent(quote.rate, liveRate.rate)
  let effectiveQuote = quote

  // Shape of the consent bound is checked whichever way the market moved. A
  // defect that only surfaces on unlucky days is worse than one that always does.
  if (request.maxAcceptableFromAmount !== undefined && quote.side === 'SELL') {
    fail('VALIDATION_ERROR', 'maxAcceptableFromAmount applies to a BUY-side quote only', {
      instance,
      correlationId,
      params: { field: '/maxAcceptableFromAmount', reason: 'NOT_ALLOWED_FOR_SIDE' },
    })
  }
  if (request.minAcceptableToAmount !== undefined && !isValidMoney(request.minAcceptableToAmount)) {
    fail('VALIDATION_ERROR', 'minAcceptableToAmount must be a valid decimal string', {
      instance,
      correlationId,
      params: { field: '/minAcceptableToAmount', reason: 'PATTERN_MISMATCH' },
    })
  }

  // Inside the tolerance, or moving our way: the quote is a COMMITMENT for its
  // TTL and is honoured as issued. Re-pricing here would hand the user a
  // different sum from the one they just confirmed, with no banner — exactly
  // the silent divergence the expected* fields exist to catch.
  if (adverseDrift > threshold) {
    const recalculated = calculateQuoteAmounts({
      rawFromAmount: quote.fromAmount,
      rate: liveRate.rate,
      policy: pair.feePolicy,
      fromDecimals: from.decimals,
      toDecimals: to.decimals,
    })

    if (
      request.minAcceptableToAmount !== undefined &&
      !lt(recalculated.toAmount, request.minAcceptableToAmount)
    ) {
      // Beyond the pair's tolerance, but the user named a floor and the live
      // market still clears it. THIS is what the bound buys: execution in a
      // region that would otherwise be refused, limited by the user's own
      // number rather than by an open-ended "yes". Re-price, because the user
      // consented to a figure, not to the stale one.
      effectiveQuote = {
        ...quote,
        ...recalculated,
        rate: liveRate.rate,
        inverseRate: inverseRate(liveRate.rate, 2),
      }
    } else {
      fail('RATE_CHANGED', 'The rate moved beyond the accepted threshold while you were confirming', {
        instance,
        correlationId,
        params: {
          quotedRate: quote.rate,
          currentRate: liveRate.rate,
          quotedToAmount: quote.toAmount,
          currentToAmount: recalculated.toAmount,
          // The adverse magnitude — the number the threshold was compared
          // against, not the raw distance between the two rates.
          driftPercent: adverseDrift.toFixed(4),
          // The threshold actually applied — the pair's own value, or the
          // default when S4 supplied none. Never a hardcoded constant: the UI
          // must explain the refusal with the same number the server used.
          thresholdPercent: threshold.toFixed(2),
          ...(request.minAcceptableToAmount === undefined
            ? {}
            : { minAcceptableToAmount: request.minAcceptableToAmount }),
        },
      })
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
      // One code per window. Collapsing YEARLY into MONTHLY told the user about
      // the wrong window — "Monthly limit reached" when the ANNUAL allowance is
      // gone invites the false conclusion "I will wait until the 1st".
      fail(LIMIT_CODE_BY_PERIOD[bucket.period], 'Turnover limit exceeded', {
        instance,
        correlationId,
        params: {
          remaining: `${bucket.remaining} ${bucket.currency}`,
          period: bucket.period,
          resetAt: bucket.resetsAt,
          // Without the zone the reset instant is a number the user cannot
          // place on any clock they own (decision O-11).
          resetTimeZone: bucket.resetTimeZone,
        },
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

// ---------------------------------------------------------------------------
// GET /v1/exchange-orders?idempotencyKey=… — state recovery (O-10, O-17)
// ---------------------------------------------------------------------------

/** Collection envelope. Zero or one element: the key is unique per user. */
export interface OrderSearchResult {
  items: ExchangeOrder[]
  total: number
}

/**
 * Finds the order created under an idempotency key.
 *
 * This is how a client that lost the response to `POST` learns the outcome
 * without blindly retrying — after a page reload the key is the only handle it
 * still has. It is a FILTER over a collection, not a lookup of a resource:
 * no match is an empty collection, never a 404. A 404 would claim the
 * collection itself does not exist, which is false.
 *
 * What actually stops key-guessing is that the search is scoped to the caller's
 * own orders, not the choice of status code — the real service filters on
 * `userId` from the token AND the key together. The prototype has a single
 * hardcoded user (canonical §10.1), so the scope is implicit here; the
 * constraint is stated because it is the security property, and an
 * implementation that dropped it would look identical from the outside.
 */
export async function findOrderByIdempotencyKey(idempotencyKey: string): Promise<OrderSearchResult> {
  const instance = '/v1/exchange-orders'
  if (!idempotencyKey) {
    fail('VALIDATION_ERROR', 'Query parameter idempotencyKey is required', {
      instance,
      params: { field: '/idempotencyKey', reason: 'REQUIRED' },
    })
  }

  await delay(60)
  const record = idempotencyStore.get(idempotencyKey)

  // The first attempt is still running: there is no answer to give yet. Telling
  // the client "nothing found" would be a lie that invites a second POST.
  if (record && !record.order && record.inFlight) {
    fail('REQUEST_IN_PROGRESS', 'A request with this idempotency key is still being processed', {
      instance,
      params: { reason: 'CLAIM_ACTIVE', retryAfterSeconds: '1' },
    })
  }

  return record?.order ? { items: [record.order], total: 1 } : { items: [], total: 0 }
}

/** Test seam: clears server-side state so scenario switches start clean. */
export function resetServerState(): void {
  quoteStore.clear()
  idempotencyStore.clear()
}

export { nowIso }
