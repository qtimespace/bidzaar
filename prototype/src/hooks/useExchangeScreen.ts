/**
 * Exchange screen state machine.
 *
 * Implements the transitions specified in `docs/UX-UI-Spec.md` §10 on top of
 * the mock BFF in `src/api/exchangeApi.ts`.
 *
 * Two deliberate deviations from the spec's state list:
 *
 * 1. `ERROR_FIELD` and `ERROR_BANNER` are not phases. They are orthogonal to
 *    the flow — an inline field error coexists with `TYPING`, a banner with
 *    `QUOTE_READY` — so modelling them as phases would force impossible
 *    choices. They live in the issue slots instead.
 * 2. Field-level problems are held in two separate slots. A locally derived
 *    issue is recomputed on every keystroke; one that came back from the server
 *    (a turnover limit, say) cannot be recomputed locally, so a shared slot
 *    meant the next validation pass silently erased it.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import {
  bootstrap as fetchBootstrap,
  createOrder,
  createQuote,
  getIndicativeRate,
  driftThresholdFor,
  RATE_LOCK_TTL_MS,
  resetServerState,
  type IndicativeRate,
} from '@/api/exchangeApi'
import type { NetworkInfo } from '@/api/services/cryptoProviderService'
import { getScenario, setScenario, SCENARIOS, type ScenarioKey } from '@/api/scenarios'
import { toLimitCurrency } from '@/api/services/limitsFeesService'
import { rateTickPeriodMs } from '@/api/runtimeConfig'
import { uuidv4 } from '@/api/transport'
import { ApiError, ERROR_CATALOG, type ErrorCode } from '@/domain/errors'
import { adverseRateDriftPercent, percentOfBalance, sanitizeInput } from '@/domain/money'
import { validateLocally, type LocalValidationIssue } from '@/domain/validation'
import type {
  Asset,
  Balance,
  ExchangeOrder,
  KycState,
  LimitBucket,
  PairConfig,
  Quote,
  UserProfile,
} from '@/domain/types'

/** Canonical §11 — long enough to stop hammering, short enough to feel live. */
const DEBOUNCE_MS = 300
/** Below this the timer turns amber (UX spec §11). */
export const TIMER_WARNING_SECONDS = 5
/**
 * Guard against an endless refresh loop on an abandoned tab.
 *
 * 20, per UX spec §11 — roughly five minutes of idle screen. The SDD originally
 * assumed 3; that would stop the clock on someone who is merely reading the
 * summary carefully, which is the opposite of what the guard is for. The two
 * documents were reconciled on 20 (SDD ASSUMPTION-11).
 */
const MAX_AUTO_REFRESHES = 20

export type Phase =
  | 'INITIALIZING'
  | 'LOADING_DATA'
  | 'READY_EMPTY'
  | 'TYPING'
  | 'QUOTING'
  | 'QUOTE_READY'
  | 'QUOTE_STALE'
  | 'RATE_CHANGED_PENDING_ACCEPT'
  | 'SUBMITTING'
  | 'SUCCESS'
  | 'MANUAL_REVIEW'
  | 'SERVICE_DOWN'

export interface RateChangeNotice {
  quotedRate: string
  currentRate: string
  quotedToAmount: string
  currentToAmount: string
  driftPercent: string
}

export interface BannerIssue {
  code: ErrorCode
  message: string
  retryable: boolean
  tone: 'warning' | 'error'
}

interface State {
  phase: Phase
  user: UserProfile | null
  kyc: KycState | null
  assets: Asset[]
  balances: Balance[]
  pairs: PairConfig[]
  limits: LimitBucket[]
  fromAssetId: string
  toAssetId: string
  /** Raw text as typed. Never parsed into a number — canonical §5.1. */
  input: string
  /** Price of the pair, independent of any amount. Shown before the user types. */
  indicativeRate: IndicativeRate | null
  indicativeLoading: boolean
  quote: Quote | null
  network: NetworkInfo | null
  /** Idempotency key bound to the current quote. A retry of the same quote
   *  reuses it, which is what makes a double click harmless. */
  idempotencyKey: string
  /** Recomputed locally on every change. */
  localIssue: LocalValidationIssue | null
  /** Returned by the server and not reproducible locally. Survives revalidation. */
  serverIssue: LocalValidationIssue | null
  bannerIssue: BannerIssue | null
  rateChange: RateChangeNotice | null
  order: ExchangeOrder | null
  secondsLeft: number
  autoRefreshCount: number
}

type Action =
  | { type: 'BOOTSTRAP_START' }
  | { type: 'BOOTSTRAP_OK'; payload: Awaited<ReturnType<typeof fetchBootstrap>> }
  | { type: 'BOOTSTRAP_FAIL'; message: string }
  | { type: 'INDICATIVE_START' }
  | { type: 'INDICATIVE_OK'; rate: IndicativeRate }
  | { type: 'INDICATIVE_FAIL' }
  | { type: 'INPUT'; value: string }
  | { type: 'SET_FROM'; assetId: string }
  | { type: 'SET_TO'; assetId: string }
  | { type: 'SWAP' }
  | { type: 'LOCAL_ISSUE'; issue: LocalValidationIssue | null }
  | { type: 'QUOTE_START' }
  | { type: 'QUOTE_OK'; quote: Quote; network: NetworkInfo | null }
  | { type: 'QUOTE_FAIL'; error: ApiError }
  | { type: 'TICK'; secondsLeft: number }
  | { type: 'MARK_STALE' }
  | { type: 'AUTO_REFRESH' }
  | { type: 'SUBMIT_START' }
  | { type: 'SUBMIT_OK'; order: ExchangeOrder }
  | { type: 'SUBMIT_FAIL'; error: ApiError }
  | { type: 'RATE_CHANGE'; notice: RateChangeNotice }
  | { type: 'ACCEPT_RATE_CHANGE' }
  | { type: 'RETRY' }
  | { type: 'RESET_FORM' }

const initialState: State = {
  phase: 'INITIALIZING',
  user: null,
  kyc: null,
  assets: [],
  balances: [],
  pairs: [],
  limits: [],
  fromAssetId: 'RUB',
  toAssetId: 'USDT',
  input: '',
  indicativeRate: null,
  indicativeLoading: false,
  quote: null,
  network: null,
  idempotencyKey: uuidv4(),
  localIssue: null,
  serverIssue: null,
  bannerIssue: null,
  rateChange: null,
  order: null,
  secondsLeft: 0,
  autoRefreshCount: 0,
}

function bannerFrom(error: ApiError): BannerIssue {
  const meta = ERROR_CATALOG[error.code]
  return {
    code: error.code,
    message: error.userMessage,
    retryable: meta.retryable,
    // A retryable problem is a hiccup, a terminal one is a refusal. Painting
    // both red teaches the user to ignore red.
    tone: meta.retryable ? 'warning' : 'error',
  }
}

function issueFrom(error: ApiError): LocalValidationIssue {
  return { code: error.code, surface: ERROR_CATALOG[error.code].surface, message: error.userMessage }
}

/**
 * Clears everything derived from the current amount and pair, including the
 * server-side verdict: a limit breach reported for 400 000 RUB says nothing
 * about 1 000 RUB. A fresh idempotency key is minted here because a changed
 * amount is a different intent, and reusing the key would make the server
 * replay the previous order instead of pricing this one.
 */
function invalidateQuote(state: State): State {
  return {
    ...state,
    quote: null,
    network: null,
    rateChange: null,
    bannerIssue: null,
    serverIssue: null,
    order: null,
    secondsLeft: 0,
    autoRefreshCount: 0,
    idempotencyKey: uuidv4(),
  }
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'BOOTSTRAP_START':
      return { ...state, phase: 'LOADING_DATA' }

    case 'BOOTSTRAP_OK':
      return {
        ...state,
        phase: 'READY_EMPTY',
        user: action.payload.user,
        kyc: action.payload.kyc,
        assets: action.payload.assets,
        balances: action.payload.balances,
        pairs: action.payload.pairs,
        limits: action.payload.limits,
        fromAssetId: action.payload.defaultPair.fromAssetId,
        toAssetId: action.payload.defaultPair.toAssetId,
      }

    case 'BOOTSTRAP_FAIL':
      return {
        ...state,
        phase: 'SERVICE_DOWN',
        bannerIssue: {
          code: 'EXCHANGE_SERVICE_UNAVAILABLE',
          message: action.message,
          retryable: true,
          tone: 'error',
        },
      }

    case 'INDICATIVE_START':
      return { ...state, indicativeLoading: true }

    case 'INDICATIVE_OK':
      return { ...state, indicativeLoading: false, indicativeRate: action.rate }

    case 'INDICATIVE_FAIL':
      return { ...state, indicativeLoading: false, indicativeRate: null }

    case 'INPUT': {
      const next = invalidateQuote({ ...state, input: action.value })
      return { ...next, phase: action.value === '' ? 'READY_EMPTY' : 'TYPING', localIssue: null }
    }

    case 'SET_FROM': {
      // Picking the asset already on the other side used to swap silently.
      // That changed both monetary values without the user touching the swap
      // control, so it is now refused at the source: the option is disabled in
      // the list (UX spec §22.6) and this guard is the backstop.
      if (action.assetId === state.toAssetId) return state
      const next = invalidateQuote({ ...state, fromAssetId: action.assetId, indicativeRate: null })
      return { ...next, phase: next.input === '' ? 'READY_EMPTY' : 'TYPING', localIssue: null }
    }

    case 'SET_TO': {
      if (action.assetId === state.fromAssetId) return state
      const next = invalidateQuote({ ...state, toAssetId: action.assetId, indicativeRate: null })
      return { ...next, phase: next.input === '' ? 'READY_EMPTY' : 'TYPING', localIssue: null }
    }

    case 'SWAP': {
      // BRD §4/§8: swapping recalculates both sides. Carrying the received
      // amount over as the new input is what makes it feel like a swap rather
      // than a reset.
      const carried = state.quote?.toAmount ?? ''
      const next = invalidateQuote({
        ...state,
        fromAssetId: state.toAssetId,
        toAssetId: state.fromAssetId,
        input: carried,
        indicativeRate: null,
      })
      return { ...next, phase: carried === '' ? 'READY_EMPTY' : 'TYPING', localIssue: null }
    }

    case 'LOCAL_ISSUE':
      if (state.localIssue === null && action.issue === null) return state // no-op, avoid a render
      return { ...state, localIssue: action.issue }

    case 'QUOTE_START':
      return state.phase === 'QUOTING' ? state : { ...state, phase: 'QUOTING' }

    case 'QUOTE_OK':
      return {
        ...state,
        // A pending rate change outranks a fresh quote: the whole point of
        // BRD §8 is that the button stays blocked until the user accepts, and
        // dropping back to QUOTE_READY here would unblock it behind the banner.
        phase: state.rateChange ? 'RATE_CHANGED_PENDING_ACCEPT' : 'QUOTE_READY',
        quote: action.quote,
        network: action.network,
        localIssue: null,
        serverIssue: null,
        bannerIssue: state.rateChange ? state.bannerIssue : null,
        secondsLeft: Math.ceil(RATE_LOCK_TTL_MS / 1000),
      }

    case 'QUOTE_FAIL': {
      const meta = ERROR_CATALOG[action.error.code]
      if (meta.surface === 'field' || meta.surface === 'select') {
        return { ...state, phase: 'TYPING', quote: null, serverIssue: issueFrom(action.error) }
      }
      // No automatic retry: the previous version re-armed the debounce on every
      // failure and hammered a downed service roughly three times a second.
      // Recovery is an explicit user action now.
      return { ...state, phase: 'SERVICE_DOWN', quote: null, bannerIssue: bannerFrom(action.error) }
    }

    case 'TICK':
      return state.secondsLeft === action.secondsLeft ? state : { ...state, secondsLeft: action.secondsLeft }

    case 'MARK_STALE':
      return state.phase === 'QUOTE_STALE' ? state : { ...state, phase: 'QUOTE_STALE', secondsLeft: 0 }

    case 'AUTO_REFRESH':
      return { ...state, autoRefreshCount: state.autoRefreshCount + 1 }

    case 'SUBMIT_START':
      return { ...state, phase: 'SUBMITTING', bannerIssue: null }

    case 'SUBMIT_OK':
      return {
        ...state,
        phase: action.order.status === 'MANUAL_REVIEW' ? 'MANUAL_REVIEW' : 'SUCCESS',
        order: action.order,
        secondsLeft: 0,
        bannerIssue: null,
        rateChange: null,
      }

    case 'SUBMIT_FAIL': {
      const meta = ERROR_CATALOG[action.error.code]
      const base = { ...state, phase: 'QUOTE_READY' as Phase }
      if (meta.surface === 'field' || meta.surface === 'select') {
        return { ...base, serverIssue: issueFrom(action.error) }
      }
      return { ...base, bannerIssue: bannerFrom(action.error) }
    }

    case 'RATE_CHANGE':
      // BRD §8: the submit button stays blocked until the user accepts the new
      // terms. That is why this is a phase and not just a banner.
      return {
        ...state,
        phase: 'RATE_CHANGED_PENDING_ACCEPT',
        rateChange: action.notice,
        bannerIssue: {
          code: 'RATE_CHANGED',
          message: ERROR_CATALOG.RATE_CHANGED.message,
          retryable: false,
          tone: 'warning',
        },
      }

    case 'ACCEPT_RATE_CHANGE':
      return {
        ...state,
        phase: state.quote ? 'QUOTE_READY' : 'TYPING',
        rateChange: null,
        bannerIssue: null,
        // The accepted quote is a new intent and needs its own key.
        idempotencyKey: uuidv4(),
        autoRefreshCount: 0,
      }

    case 'RETRY':
      return {
        ...state,
        phase: state.input === '' ? 'READY_EMPTY' : 'TYPING',
        bannerIssue: null,
        autoRefreshCount: 0,
      }

    case 'RESET_FORM':
      return { ...invalidateQuote(state), input: '', phase: 'READY_EMPTY', localIssue: null }

    default:
      return state
  }
}

/** Scenario switches now come from the URL instead of an on-screen panel:
 *  `?scenario=RATE_DRIFT`. The panel was removed at the customer's request —
 *  the prototype should show the exchange page, not its test harness. */
function scenarioFromUrl(): ScenarioKey | null {
  if (typeof window === 'undefined') return null
  const raw = new URLSearchParams(window.location.search).get('scenario')
  if (!raw) return null
  const key = raw.toUpperCase() as ScenarioKey
  return key in SCENARIOS ? key : null
}

export function useExchangeScreen() {
  const [state, dispatch] = useReducer(reducer, initialState)

  /** Guards against out-of-order quote responses: only the newest wins. */
  const quoteSeq = useRef(0)
  const submitInFlight = useRef(false)
  /** Mirrors `state.quote` so the drift check can read it without re-creating
   *  `requestQuote` on every new quote. */
  const previousQuote = useRef<Quote | null>(null)

  useEffect(() => {
    previousQuote.current = state.quote
  }, [state.quote])

  // ---- scenario from the URL -------------------------------------------
  useEffect(() => {
    const key = scenarioFromUrl()
    if (key) {
      resetServerState()
      setScenario(key)
    }
  }, [])

  // ---- bootstrap --------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    dispatch({ type: 'BOOTSTRAP_START' })
    fetchBootstrap()
      .then((payload) => {
        if (!cancelled) dispatch({ type: 'BOOTSTRAP_OK', payload })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const message = error instanceof ApiError ? error.userMessage : 'Exchange is temporarily unavailable'
        dispatch({ type: 'BOOTSTRAP_FAIL', message })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // ---- derived lookups --------------------------------------------------
  const fromAsset = useMemo(
    () => state.assets.find((a) => a.assetId === state.fromAssetId),
    [state.assets, state.fromAssetId],
  )
  const toAsset = useMemo(
    () => state.assets.find((a) => a.assetId === state.toAssetId),
    [state.assets, state.toAssetId],
  )
  const pair = useMemo(
    () => state.pairs.find((p) => p.fromAssetId === state.fromAssetId && p.toAssetId === state.toAssetId),
    [state.pairs, state.fromAssetId, state.toAssetId],
  )
  const fromBalance = useMemo(
    () => state.balances.find((b) => b.assetId === state.fromAssetId),
    [state.balances, state.fromAssetId],
  )
  const toBalance = useMemo(
    () => state.balances.find((b) => b.assetId === state.toAssetId),
    [state.balances, state.toAssetId],
  )

  const sanitized = useMemo(() => sanitizeInput(state.input), [state.input])

  // ---- indicative rate, independent of the amount -----------------------
  // BRD §3 loads rates when the screen opens and §4 requires the rate to be
  // visible; neither is conditional on having typed an amount.
  useEffect(() => {
    if (state.assets.length === 0) return
    if (!pair) return
    // Once a quote exists it owns the displayed rate; polling underneath it
    // would show two different prices at once.
    if (state.quote) return
    if (state.phase === 'SUBMITTING' || state.phase === 'SUCCESS' || state.phase === 'MANUAL_REVIEW') return
    if (state.phase === 'SERVICE_DOWN') return

    let cancelled = false

    const load = () => {
      dispatch({ type: 'INDICATIVE_START' })
      getIndicativeRate(state.fromAssetId, state.toAssetId)
        .then((rate) => {
          if (!cancelled) dispatch({ type: 'INDICATIVE_OK', rate })
        })
        .catch(() => {
          if (!cancelled) dispatch({ type: 'INDICATIVE_FAIL' })
        })
    }

    load()
    // The simulated market moves once per window, so a rate shown before the
    // user types would otherwise go stale on an idle screen and then disagree
    // with the first quote they get.
    const handle = setInterval(load, rateTickPeriodMs())
    return () => {
      cancelled = true
      clearInterval(handle)
    }
  }, [state.assets.length, state.fromAssetId, state.toAssetId, state.quote, state.phase, pair])

  // ---- debounced local validation + quote -------------------------------
  const requestQuote = useCallback(
    async (amount: string, options: { detectDrift?: boolean } = {}) => {
      const seq = ++quoteSeq.current
      const before = previousQuote.current
      dispatch({ type: 'QUOTE_START' })
      try {
        const result = await createQuote({
          fromAsset: { assetId: state.fromAssetId, network: fromAsset?.network },
          toAsset: { assetId: state.toAssetId, network: toAsset?.network },
          fromAmount: amount,
        })
        if (seq !== quoteSeq.current) return

        // BRD §8: a rate that moves *while the form is being filled in* must
        // warn and block, not just one that moves at submit time. Without this
        // the auto-refresh silently replaced the amount under the user's cursor.
        if (options.detectDrift && before) {
          // Same rule as the server, in both respects: the pair's own tolerance
          // rather than a global constant (O-8), and only movement against the
          // system (O-18). Either mismatch would put a banner on screen that
          // the server then declines to confirm — the user gets asked to accept
          // conditions that were never in question.
          const drift = adverseRateDriftPercent(before.rate, result.quote.rate)
          if (drift > driftThresholdFor(pair ?? {})) {
            dispatch({
              type: 'RATE_CHANGE',
              notice: {
                quotedRate: before.rate,
                currentRate: result.quote.rate,
                quotedToAmount: before.toAmount,
                currentToAmount: result.quote.toAmount,
                driftPercent: drift.toFixed(4),
              },
            })
          }
        }

        dispatch({ type: 'QUOTE_OK', quote: result.quote, network: result.network })
      } catch (error) {
        if (seq !== quoteSeq.current) return
        if (error instanceof ApiError) dispatch({ type: 'QUOTE_FAIL', error })
        else throw error
      }
    },
    [state.fromAssetId, state.toAssetId, fromAsset?.network, toAsset?.network, pair],
  )

  useEffect(() => {
    if (state.phase === 'INITIALIZING' || state.phase === 'LOADING_DATA') return
    if (state.phase === 'SUBMITTING' || state.phase === 'SUCCESS' || state.phase === 'MANUAL_REVIEW') return
    // A downed service is recovered by the Retry button, never by re-arming
    // the debounce.
    if (state.phase === 'SERVICE_DOWN') return

    const issue = validateLocally({
      amount: sanitized === '' ? '' : sanitized,
      fromAsset,
      toAsset,
      pair,
      balance: fromBalance,
      limits: state.limits,
      toLimitCurrency,
    })

    if (issue) {
      quoteSeq.current++ // cancel any in-flight quote
      dispatch({ type: 'LOCAL_ISSUE', issue })
      return
    }

    dispatch({ type: 'LOCAL_ISSUE', issue: null })
    if (sanitized === '') return
    if (state.quote) return // already priced; the timer owns refreshes from here
    if (state.serverIssue) return // the server already rejected this exact input

    const handle = setTimeout(() => void requestQuote(sanitized), DEBOUNCE_MS)
    return () => clearTimeout(handle)
    // `state.quote` is intentionally in the dependency list: clearing it (via
    // invalidateQuote) is what re-arms this effect after an input change.
  }, [
    sanitized,
    fromAsset,
    toAsset,
    pair,
    fromBalance,
    state.phase,
    state.quote,
    state.serverIssue,
    state.limits,
    requestQuote,
  ])

  // ---- rate lock countdown ---------------------------------------------
  useEffect(() => {
    if (!state.quote) return
    if (state.phase === 'SUBMITTING' || state.phase === 'SUCCESS' || state.phase === 'MANUAL_REVIEW') return
    // Frozen while the user is being asked to accept a new rate: refreshing
    // underneath that question would replace the very numbers being offered,
    // and on the next tick would silently re-enable the button.
    if (state.phase === 'RATE_CHANGED_PENDING_ACCEPT') return
    if (state.phase === 'QUOTE_STALE') return

    const expiresAt = Date.parse(state.quote.expiresAt)

    const tick = () => {
      const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
      dispatch({ type: 'TICK', secondsLeft: left })

      if (left > 0) return

      // Expiry refreshes the quote rather than blocking the screen: BRD §4 sells
      // a 15-second lock, not a 15-second deadline. Freezing the UI instead
      // would punish someone for reading carefully.
      if (state.autoRefreshCount >= MAX_AUTO_REFRESHES) {
        dispatch({ type: 'MARK_STALE' })
        return
      }
      dispatch({ type: 'AUTO_REFRESH' })
      void requestQuote(sanitized, { detectDrift: true })
    }

    const handle = setInterval(tick, 250)
    tick()
    return () => clearInterval(handle)
  }, [state.quote, state.phase, state.autoRefreshCount, sanitized, requestQuote])

  // ---- refresh a stale quote when the tab comes back --------------------
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (!state.quote) return
      if (state.phase === 'SUBMITTING' || state.phase === 'SUCCESS' || state.phase === 'MANUAL_REVIEW') return
      if (state.phase === 'RATE_CHANGED_PENDING_ACCEPT') return
      if (Date.now() < Date.parse(state.quote.expiresAt)) return
      void requestQuote(sanitized, { detectDrift: true })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [state.quote, state.phase, sanitized, requestQuote])

  // ---- actions ----------------------------------------------------------
  const setInput = useCallback((value: string) => {
    dispatch({ type: 'INPUT', value })
  }, [])

  const applyPercent = useCallback(
    (percent: number) => {
      if (!fromAsset || !fromBalance) return
      dispatch({
        type: 'INPUT',
        value: percentOfBalance(fromBalance.available, percent, fromAsset.decimals),
      })
    },
    [fromAsset, fromBalance],
  )

  const submit = useCallback(async () => {
    if (!state.quote) return
    if (state.phase === 'RATE_CHANGED_PENDING_ACCEPT') return
    // Second line of defence against a double click; the first is the
    // idempotency key, which makes a duplicate request harmless anyway.
    if (submitInFlight.current) return
    submitInFlight.current = true

    dispatch({ type: 'SUBMIT_START' })
    try {
      const { order } = await createOrder({
        quoteId: state.quote.quoteId,
        fromAsset: state.quote.fromAsset,
        toAsset: state.quote.toAsset,
        fromAmount: state.quote.fromAmount,
        expectedToAmount: state.quote.toAmount,
        expectedRate: state.quote.rate,
        // No consent bound is sent (decision O-16). The UI has no control for
        // naming one, and inventing a default here would be consent the user
        // never gave. Without it the pair's own threshold is the only guard,
        // which is exactly the intended behaviour for this screen.
        idempotencyKey: state.idempotencyKey,
      })
      dispatch({ type: 'SUBMIT_OK', order })
    } catch (error) {
      if (!(error instanceof ApiError)) throw error

      if (error.code === 'RATE_CHANGED') {
        const p = error.problem.params ?? {}
        // Raise the banner FIRST: `QUOTE_OK` keeps the pending-accept phase
        // when a notice is already present, so the re-price below cannot
        // unblock the button behind the question.
        dispatch({
          type: 'RATE_CHANGE',
          notice: {
            quotedRate: p.quotedRate ?? '',
            currentRate: p.currentRate ?? '',
            quotedToAmount: p.quotedToAmount ?? '',
            currentToAmount: p.currentToAmount ?? '',
            driftPercent: p.driftPercent ?? '',
          },
        })
        // Re-price so the user accepts numbers that are actually purchasable,
        // not the ones the rejected attempt reported.
        await requestQuote(sanitized)
        return
      }

      if (error.code === 'QUOTE_EXPIRED' || error.code === 'QUOTE_NOT_FOUND') {
        dispatch({ type: 'SUBMIT_FAIL', error })
        await requestQuote(sanitized)
        return
      }

      dispatch({ type: 'SUBMIT_FAIL', error })
    } finally {
      submitInFlight.current = false
    }
  }, [state.quote, state.phase, state.idempotencyKey, sanitized, requestQuote])

  const acceptRateChange = useCallback(() => dispatch({ type: 'ACCEPT_RATE_CHANGE' }), [])
  const swap = useCallback(() => dispatch({ type: 'SWAP' }), [])
  const setFromAsset = useCallback((assetId: string) => dispatch({ type: 'SET_FROM', assetId }), [])
  const setToAsset = useCallback((assetId: string) => dispatch({ type: 'SET_TO', assetId }), [])
  const reset = useCallback(() => dispatch({ type: 'RESET_FORM' }), [])
  const retry = useCallback(() => dispatch({ type: 'RETRY' }), [])

  // A server verdict outranks a local one: it is strictly better informed.
  const activeIssue = state.serverIssue ?? state.localIssue
  const fieldIssue = activeIssue?.surface === 'field' ? activeIssue : null
  const selectIssue = activeIssue?.surface === 'select' ? activeIssue : null

  const canSubmit =
    state.phase === 'QUOTE_READY' &&
    state.quote !== null &&
    fieldIssue === null &&
    selectIssue === null &&
    // A banner reports something the form cannot fix — verification pending, a
    // declined score, a downed service. Leaving the button blue under it
    // invites a click that can only fail.
    state.bannerIssue === null &&
    state.secondsLeft > 0

  return {
    ...state,
    fieldIssue,
    selectIssue,
    fromAsset,
    toAsset,
    pair,
    fromBalance,
    toBalance,
    canSubmit,
    scenario: getScenario(),
    isBusy: state.phase === 'QUOTING' || state.phase === 'SUBMITTING',
    actions: {
      setInput,
      setFromAsset,
      setToAsset,
      swap,
      applyPercent,
      acceptRateChange,
      submit,
      reset,
      retry,
    },
  }
}

export type ExchangeScreenModel = ReturnType<typeof useExchangeScreen>
