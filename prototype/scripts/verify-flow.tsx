/**
 * End-to-end flow test in jsdom.
 *
 * Run from `prototype/`:  npm run verify:flow
 *
 * The SSR smoke test proves the tree renders; it cannot prove the screen
 * *works*, because effects, timers and promises never run there. This one
 * mounts the real app in a DOM, types into the real input and clicks the real
 * button, then asserts what a person would see.
 */

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  // The market tick is frozen for the deterministic assertions below, so the
  // amounts can be compared against the feature file. Ticking gets its own
  // check at the end, with a short window.
  url: 'http://localhost:5173/?rateTick=off',
  pretendToBeVisual: true,
})

const g = globalThis as unknown as Record<string, unknown>
g.window = dom.window
g.document = dom.window.document
// Node 22 defines `navigator` as a getter-only global, so it has to be
// redefined rather than assigned.
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
})
g.HTMLElement = dom.window.HTMLElement
g.HTMLInputElement = dom.window.HTMLInputElement
g.Element = dom.window.Element
g.Node = dom.window.Node
g.Event = dom.window.Event
g.CustomEvent = dom.window.CustomEvent
g.getComputedStyle = dom.window.getComputedStyle
g.requestAnimationFrame = (cb: FrameRequestCallback) => dom.window.setTimeout(() => cb(Date.now()), 16)
g.cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id)
// jsdom ships no matchMedia and no layout engine, so the breakpoint is
// simulated rather than measured. `viewport` is flipped by the mobile pass
// below to exercise the bottom-sheet branch of the asset picker.
let viewport: 'desktop' | 'mobile' = 'desktop'
const fakeMatchMedia = (query: string) => ({
  matches: viewport === 'mobile' && query.includes('max-width: 480px'),
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})
g.matchMedia = fakeMatchMedia
// jsdom supplies its own `window.matchMedia` that never matches, and the
// component reads `window.matchMedia` rather than the global — overriding only
// the global would leave the mobile branch permanently unreachable.
Object.defineProperty(dom.window, 'matchMedia', { value: fakeMatchMedia, configurable: true, writable: true })
// jsdom implements no layout, so these are no-ops rather than throws.
dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {}
g.IS_REACT_ACT_ENVIRONMENT = true

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const log: string[] = []
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++
  log.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`)
}

const doc = dom.window.document
const $ = (sel: string) => doc.querySelector(sel)
const $$ = (sel: string) => Array.from(doc.querySelectorAll(sel))
const text = (sel: string) => $(sel)?.textContent?.trim() ?? ''

function inputs(): HTMLInputElement[] {
  return $$('.amount-field__input') as unknown as HTMLInputElement[]
}

/** Types into a controlled React input the way a browser would. */
function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

function findButton(label: string) {
  return ($$('button') as unknown as HTMLButtonElement[]).find((b) =>
    (b.textContent ?? '').toLowerCase().includes(label.toLowerCase()),
  )
}

// ---------------------------------------------------------------------------

async function main() {
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { default: App } = await import('../src/App')

/** Let React flush effects, then let the mock services' timers resolve. */
const settle = async (ms: number) => {
  await act(async () => {
    await sleep(ms)
  })
}

const root = createRoot(doc.getElementById('root')!)
await act(async () => {
  root.render(createElement(App))
})

// 1. Bootstrap: skeletons must give way to real controls.
await settle(600)
check('bootstrap finished (no skeletons left)', $$('.skeleton').length === 0, `${$$('.skeleton').length} skeletons still on screen`)
check('two amount fields rendered', inputs().length === 2, `found ${inputs().length}`)

// 1a. Removed at the customer's request (2026-08-07).
check('balances strip is gone', $$('.balances').length === 0)
check('scenario panel is gone', $$('.devpanel').length === 0 && $$('aside').length === 0)

// 1b. BRD §3/§4: the rate is loaded when the screen opens, before any amount
// exists. This is the regression the customer reported as "rates do not load".
await settle(400) // indicative rate arrives after the bootstrap fan-out
check(
  'rate is visible before typing anything',
  text('.summary').includes('1 USDT = 94.00 RUB'),
  `summary: ${text('.summary').slice(0, 160)}`,
)
check('total debited row present (BRD §4.11)', text('.summary').includes('Total debited'))

// 1c. Balances moved into the asset picker.
const payTrigger = ($('[data-testid="pay-select"] .asset-select__trigger') as unknown as HTMLButtonElement) ?? null
check('pay asset trigger present', Boolean(payTrigger))
if (payTrigger) {
  await act(async () => {
    payTrigger.click()
  })
  const listbox = $('[data-testid="pay-listbox"]')
  check('asset list opens', Boolean(listbox))
  // Thousands are grouped with a non-breaking space, so compare on normalised
  // whitespace rather than on the literal glyph.
  const listText = (listbox?.textContent ?? '').replace(/\s/g, ' ')
  check('list shows RUB balance', listText.includes('25 450.00'), listText.slice(0, 220))
  check('list shows ETH available, not total', listText.includes('0.76') && !listText.includes('0.86'), listText.slice(0, 260))
  check('list flags held funds', listText.includes('on hold'), listText.slice(0, 260))
  check('list shows zero-balance asset', listText.includes('No funds'), listText.slice(0, 260))
  check('same asset is disabled in the pay list', Boolean($('[data-testid="asset-option-USDT"][aria-disabled="true"]')))
  await act(async () => {
    dom.window.document.dispatchEvent(new dom.window.Event('mousedown', { bubbles: true }))
  })
  check('asset list closes on outside click', !$('[data-testid="pay-listbox"]'))
}

// 2. Typing an amount must produce a quote.
const payInput = inputs()[0]
check('pay input is editable', Boolean(payInput) && !payInput.readOnly)
await act(async () => {
  type(payInput, '10000')
})
await settle(1500)

const receiveInput = inputs()[1]
check(
  'receive amount is calculated after typing',
  (receiveInput?.value ?? '') !== '',
  `receive="${receiveInput?.value}" · summary rate="${text('.summary__row:nth-child(1) .summary__value')}"`,
)
check(
  'receive amount equals 106.010638',
  receiveInput?.value === '106.010638',
  `got "${receiveInput?.value}"`,
)
check('rate row is filled', text('.summary').includes('1 USDT = 94.00 RUB'), text('.summary'))
check('fee row shows 35.00 RUB', text('.summary').includes('35.00 RUB'), text('.summary'))
check('no inline error', $$('.inline-error').length === 0, text('.inline-error'))

// 3. The submit button must become enabled.
const submit = findButton('Exchange Now')
check('submit button present', Boolean(submit))
check('submit button is enabled', submit ? !submit.disabled : false, `reason: "${text('.submit__reason')}"`)

// 4. Clicking it must create an order.
if (submit && !submit.disabled) {
  await act(async () => {
    submit.click()
  })
  await settle(1500)
  check('success panel shown', Boolean($('.success')), `phase text: ${text('.card')}`.slice(0, 200))
  check('order id shown', text('.success').includes('ord_'), text('.success').slice(0, 200))
  check('status is PENDING', text('.success').includes('PENDING'), text('.success').slice(0, 200))
} else {
  check('order created', false, 'submit button never became enabled — skipped')
}

// 5. Mobile pass: below 480 px the picker must become a bottom sheet rather
// than an anchored dropdown (BRD §9, UX spec §22.4). jsdom has no layout, so
// this checks the branch, not the pixels.
viewport = 'mobile'
await act(async () => {
  root.unmount()
})
const mobileHost = doc.createElement('div')
doc.body.appendChild(mobileHost)
const mobileRoot = createRoot(mobileHost)
await act(async () => {
  mobileRoot.render(createElement(App))
})
await settle(900)
const mobileTrigger = ($('[data-testid="pay-select"] .asset-select__trigger') as unknown as HTMLButtonElement) ?? null
check('mobile: trigger rendered', Boolean(mobileTrigger))
if (mobileTrigger) {
  await act(async () => {
    mobileTrigger.click()
  })
  check('mobile: picker opens as a bottom sheet', Boolean($('.asset-select__sheet')))
  check('mobile: sheet has a dimmed overlay', Boolean($('.asset-select__overlay')))
  check('mobile: anchored dropdown is not used', !$('.asset-select__panel'))
}

// 6. Market tick: the published rate must actually move once a window elapses,
// otherwise the 15-second lock re-prices to the identical number and the timer
// is decorative. Uses a 300 ms window so the check does not take 15 seconds.
const { getIndicativeRate } = await import('../src/api/exchangeApi')
dom.reconfigure({ url: 'http://localhost:5173/?rateTickMs=300&rateTickFactor=0.99' })
const firstTick = await getIndicativeRate('RUB', 'USDT')
await sleep(700)
const secondTick = await getIndicativeRate('RUB', 'USDT')
check(
  'rate changes after a market window elapses',
  firstTick.rate !== secondTick.rate,
  `${firstTick.rate} -> ${secondTick.rate}`,
)
dom.reconfigure({ url: 'http://localhost:5173/?rateTick=off' })
const frozenA = await getIndicativeRate('RUB', 'USDT')
await sleep(400)
const frozenB = await getIndicativeRate('RUB', 'USDT')
check('rateTick=off freezes the market', frozenA.rate === frozenB.rate, `${frozenA.rate} -> ${frozenB.rate}`)
check('frozen rate is the published fixture rate', frozenA.rate === '0.010638297872', frozenA.rate)

// 7. Contract conformance for the API surface the UI does not exercise.
//
// Decisions O-8..O-17 added branches that no user action can reach: the screen
// never sends `side: BUY`, never names a consent bound and never searches by
// idempotency key. A branch whose only consumer is a test is still better than
// a branch with no consumer at all — without these the code would be present
// but unproven, and its first real call would happen in production.
const api = await import('../src/api/exchangeApi')
const { LIMITS, PAIRS } = await import('../src/api/fixtures')
const { ApiError } = await import('../src/domain/errors')

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run()
    return 'NO_ERROR'
  } catch (error) {
    return error instanceof ApiError ? error.code : `UNEXPECTED:${String(error)}`
  }
}

const RUB = { assetId: 'RUB' as const, network: undefined }
const USDT = { assetId: 'USDT' as const, network: 'TRON' as const }

// O-9: the side is part of the contract; the reverse mode is a declared stub.
const buyCode = await codeOf(() =>
  api.createQuote({ fromAsset: RUB, toAsset: USDT, side: 'BUY', toAmount: '100.000000' }),
)
check('side=BUY is rejected as unimplemented, not silently mispriced', buyCode === 'VALIDATION_ERROR', buyCode)
const bothCode = await codeOf(() =>
  api.createQuote({ fromAsset: RUB, toAsset: USDT, side: 'SELL', fromAmount: '10000.00', toAmount: '100.000000' }),
)
check('side=SELL rejects a toAmount', bothCode === 'VALIDATION_ERROR', bothCode)
const neitherCode = await codeOf(() => api.createQuote({ fromAsset: RUB, toAsset: USDT, side: 'SELL' }))
check('a quote request with no amount is rejected', neitherCode === 'VALIDATION_ERROR', neitherCode)

// Omitting `side` must behave exactly as before — that is what makes O-9 a
// compatible change rather than a breaking one.
const legacyQuote = await api.createQuote({ fromAsset: RUB, toAsset: USDT, fromAmount: '10000.00' })
check('omitting side defaults to SELL', legacyQuote.quote.side === 'SELL', legacyQuote.quote.side)
check('quote carries the originally requested amount', legacyQuote.quote.requestedAmount === '10000.00', legacyQuote.quote.requestedAmount)
check('legacy request still prices identically', legacyQuote.quote.toAmount === '106.010638', legacyQuote.quote.toAmount)

// O-8: the threshold is a property of the pair, and a pair without one is a
// degraded quote rather than a silently normal one.
const rubUsdt = PAIRS.find((p) => p.fromAssetId === 'RUB' && p.toAssetId === 'USDT')!
const rubBtc = PAIRS.find((p) => p.fromAssetId === 'RUB' && p.toAssetId === 'BTC')!
const rubEur = PAIRS.find((p) => p.fromAssetId === 'RUB' && p.toAssetId === 'EUR')!
check('drift threshold is per pair, not global', api.driftThresholdFor(rubBtc) > api.driftThresholdFor(rubUsdt), `${api.driftThresholdFor(rubUsdt)} vs ${api.driftThresholdFor(rubBtc)}`)
check('a pair without a threshold falls back to the default', api.driftThresholdFor(rubEur) === api.DEFAULT_RATE_DRIFT_THRESHOLD_PERCENT, String(api.driftThresholdFor(rubEur)))
const eurQuote = await api.createQuote({ fromAsset: RUB, toAsset: { assetId: 'EUR' }, fromAmount: '10000.00' })
check('a defaulted threshold marks the quote degraded', eurQuote.quote.degraded === true)
check('a configured threshold leaves the quote undegraded', legacyQuote.quote.degraded === false)

// O-12: the yearly window must be reachable, or the code is decoration.
const yearly = LIMITS.find((b) => b.period === 'YEARLY')!
const daily = LIMITS.find((b) => b.period === 'DAILY')!
check('a yearly window exists in the fixtures', Boolean(yearly))
check('yearly carries a reset zone', yearly.resetTimeZone === 'UTC', yearly.resetTimeZone)
check(
  'the yearly window is the binding one in its band',
  Number(yearly.remaining) < Number(daily.remaining),
  `${yearly.remaining} < ${daily.remaining}`,
)
const yearlyCode = await codeOf(() =>
  api.createOrder({
    quoteId: legacyQuote.quote.quoteId,
    fromAsset: RUB,
    toAsset: USDT,
    fromAmount: '10000.00',
    expectedToAmount: legacyQuote.quote.toAmount,
    expectedRate: legacyQuote.quote.rate,
    idempotencyKey: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  }),
)
check('a normal amount clears every limit window', yearlyCode === 'NO_ERROR', yearlyCode)

// The amount below sits between the yearly and the daily allowance, so only
// the annual window can refuse it. Limits are step 15 and the balance is step
// 17, so this reports the limit rather than INSUFFICIENT_FUNDS.
const bigQuote = await api.createQuote({ fromAsset: RUB, toAsset: USDT, fromAmount: '300000.00' })
const bigCode = await codeOf(() =>
  api.createOrder({
    quoteId: bigQuote.quote.quoteId,
    fromAsset: RUB,
    toAsset: USDT,
    fromAmount: '300000.00',
    expectedToAmount: bigQuote.quote.toAmount,
    expectedRate: bigQuote.quote.rate,
    idempotencyKey: 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff',
  }),
)
check('an exhausted annual allowance names the YEARLY window', bigCode === 'LIMIT_EXCEEDED_YEARLY', bigCode)

// O-18: the threshold is one-sided. A move in the user's favour, however large,
// must NOT raise RATE_CHANGED — the quote is honoured at its locked rate, the
// user receives what they confirmed, and the difference stays with the system.
const { adverseRateDriftPercent, rateDriftPercent } = await import('../src/domain/money')
const quoted = '0.010638297872'
const fell = '0.010000000000'
const rose = '0.011500000000'
check('a falling rate counts as adverse drift', adverseRateDriftPercent(quoted, fell) > 0, adverseRateDriftPercent(quoted, fell).toFixed(4))
check('a rising rate is not adverse drift', adverseRateDriftPercent(quoted, rose) === 0, adverseRateDriftPercent(quoted, rose).toFixed(4))
check('the absolute measure still sees both', rateDriftPercent(quoted, rose) > 0 && rateDriftPercent(quoted, fell) > 0)

// End to end: a +5 % move is far beyond every pair threshold in the fixtures,
// yet the order must go through at the QUOTED rate with no banner.
const favQuote = await api.createQuote({ fromAsset: RUB, toAsset: USDT, fromAmount: '10000.00' })
dom.reconfigure({ url: 'http://localhost:5173/?rateTickMs=100&rateTickFactor=1.05' })
await sleep(250)
let favOrder: Awaited<ReturnType<typeof api.createOrder>> | null = null
const favCode = await codeOf(async () => {
  favOrder = await api.createOrder({
    quoteId: favQuote.quote.quoteId,
    fromAsset: RUB,
    toAsset: USDT,
    fromAmount: '10000.00',
    expectedToAmount: favQuote.quote.toAmount,
    expectedRate: favQuote.quote.rate,
    idempotencyKey: 'bbbbbbbb-cccc-4ddd-8eee-111111111111',
  })
  return favOrder
})
check('a favourable move beyond the threshold does not raise RATE_CHANGED', favCode === 'NO_ERROR', favCode)
check(
  'a favourable move executes at the quoted rate',
  favOrder !== null && favOrder!.order.rate === favQuote.quote.rate,
  `${favOrder?.order.rate} vs quoted ${favQuote.quote.rate}`,
)
check(
  'the user receives exactly the confirmed amount',
  favOrder !== null && favOrder!.order.toAmount === favQuote.quote.toAmount,
  `${favOrder?.order.toAmount} vs confirmed ${favQuote.quote.toAmount}`,
)

// The mirror case: the same magnitude against the system is still refused.
const advQuote = await api.createQuote({ fromAsset: RUB, toAsset: USDT, fromAmount: '10000.00' })
dom.reconfigure({ url: 'http://localhost:5173/?rateTickMs=100&rateTickFactor=0.95' })
await sleep(250)
const advCode = await codeOf(() =>
  api.createOrder({
    quoteId: advQuote.quote.quoteId,
    fromAsset: RUB,
    toAsset: USDT,
    fromAmount: '10000.00',
    expectedToAmount: advQuote.quote.toAmount,
    expectedRate: advQuote.quote.rate,
    idempotencyKey: 'bbbbbbbb-cccc-4ddd-8eee-222222222222',
  }),
)
check('an adverse move of the same size is still refused', advCode === 'RATE_CHANGED', advCode)
dom.reconfigure({ url: 'http://localhost:5173/?rateTick=off' })

// O-10/O-17: recovery by key is a filter over a collection — an empty result,
// never a 404.
const found = await api.findOrderByIdempotencyKey('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
check('a known key returns exactly one order', found.total === 1 && found.items.length === 1, String(found.total))
check('the recovered order is the one that was created', found.items[0]?.idempotencyKey === 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
check('the recovered order carries the audit side', found.items[0]?.side === 'SELL', String(found.items[0]?.side))
const missing = await api.findOrderByIdempotencyKey('00000000-0000-4000-8000-000000000000')
check('an unknown key returns an empty collection, not an error', missing.total === 0 && missing.items.length === 0)
const noKeyCode = await codeOf(() => api.findOrderByIdempotencyKey(''))
check('searching without a key is rejected', noKeyCode === 'VALIDATION_ERROR', noKeyCode)

}

main().then(
  () => {
    console.log(log.join('\n'))
    console.log(`\n${failures === 0 ? 'ALL FLOW CHECKS PASSED' : failures + ' FLOW CHECK(S) FAILED'}`)
    process.exit(failures === 0 ? 0 : 1)
  },
  (error) => {
    console.log(log.join('\n'))
    console.error('\nFLOW TEST CRASHED:', error)
    process.exit(1)
  },
)
