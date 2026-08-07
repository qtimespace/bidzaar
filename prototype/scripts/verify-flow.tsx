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
