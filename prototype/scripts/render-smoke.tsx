/**
 * Server-side render smoke test.
 * Run from `prototype/`:  npm run verify:render
 *
 * There is no browser in this environment, so this is how the component tree
 * gets exercised for real: it renders the shell in its initial loading state
 * plus the two states that only appear later (a priced summary and the success
 * panel), and asserts the numbers on screen match the ones in
 * `docs/features/exchange-order.feature`.
 */
import { renderToString } from 'react-dom/server'
import App from '../src/App'
import { ExchangeSummary } from '../src/components/ExchangeSummary'
import { SuccessPanel } from '../src/components/SuccessPanel'
import { ASSETS } from '../src/api/fixtures'
import { calculateQuoteAmounts } from '../src/domain/money'
import type { Quote, ExchangeOrder } from '../src/domain/types'

const from = ASSETS[0]
const to = ASSETS[1]
const a = calculateQuoteAmounts({
  rawFromAmount: '10000.00',
  rate: '0.010638297872',
  policy: { mode: 'INCLUDED_IN_SOURCE', percent: '0.35', minFee: '10.00', maxFee: null, networkFee: '0' },
  fromDecimals: from.decimals,
  toDecimals: to.decimals,
})
const quote: Quote = {
  quoteId: 'q1', fromAsset: { assetId: 'RUB' }, toAsset: { assetId: 'USDT', network: 'TRON' },
  ...a, rate: '0.010638297872', inverseRate: '94.00',
  feePolicy: { mode: 'INCLUDED_IN_SOURCE', percent: '0.35', minFee: '10.00', maxFee: null, networkFee: '0' },
  rateSource: 'AGGREGATED', quotedAt: '2026-08-07T10:00:00.000Z', expiresAt: '2026-08-07T10:00:15.000Z', degraded: false,
}
const order: ExchangeOrder = {
  orderId: 'ord_01J9X', status: 'PENDING', quoteId: 'q1',
  fromAsset: { assetId: 'RUB' }, toAsset: { assetId: 'USDT', network: 'TRON' },
  fromAmount: a.fromAmount, feeAmount: a.feeAmount, toAmount: a.toAmount, rate: '0.010638297872',
  holdId: 'hold_1', createdAt: '2026-08-07T10:00:01.000Z', estimatedCompletionAt: '2026-08-07T10:00:31.000Z',
  idempotencyKey: 'k', correlationId: 'c',
}

const shell = renderToString(<App />)
const summary = renderToString(
  <ExchangeSummary quote={quote} fromAsset={from} toAsset={to} network={null} secondsLeft={12} stale={false} loading={false} />,
)
const success = renderToString(<SuccessPanel order={order} fromAsset={from} toAsset={to} onDone={() => {}} />)

const checks: Array<[string, boolean]> = [
  ['shell: card renders', shell.includes('class="card"')],
  ['shell: title Exchange', shell.includes('>Exchange<')],
  ['shell: You Pay / You Receive', shell.includes('You Pay') && shell.includes('You Receive')],
  ['shell: swap button', shell.includes('swap-button')],
  ['shell: MAX button absent while loading', !shell.includes('max-button')],
  ['shell: submit button', shell.includes('Exchange Now')],
  ['shell: disabled submit carries a reason', shell.includes('submit__reason')],
  // Removed at the customer's request (2026-08-07): the prototype shows the
  // exchange page, not the harness around it. Scenarios moved to ?scenario=.
  ['shell: no dev scenario panel', !shell.includes('devpanel')],
  ['shell: no balances strip', !shell.includes('class="balances"')],
  ['shell: skeletons while loading', shell.includes('skeleton')],
  // Five rows from the Design Brief plus "Total debited", which BRD §4.11
  // requires and the brief omits.
  ['summary: all six rows', ['Current Rate', 'Fee', 'Total debited', 'Estimated Receive', 'Rate updates in', 'Network'].every((r) => summary.includes(r))],
  ['summary: rate line reads 1 USDT = 94.00 RUB', summary.includes('1 USDT = 94.00 RUB')],
  ['summary: fee 35.00 RUB', summary.includes('35.00 RUB')],
  ['summary: receive 106.010638 USDT', summary.includes('106.010638 USDT')],
  ['summary: network TRON', summary.includes('TRON')],
  ['success: order id shown', success.includes('ord_01J9X')],
  ['success: status pill PENDING', success.includes('PENDING')],
  ['success: not claiming completion', !success.includes('Completed')],
]
let failed = 0
for (const [name, ok] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}
console.log(`\n${failed === 0 ? 'ALL RENDER CHECKS PASSED' : failed + ' FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
