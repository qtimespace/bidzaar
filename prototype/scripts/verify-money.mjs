/**
 * Standalone verification of the money layer against the numbers published in
 * `docs/features/exchange-order.feature`. Run from `prototype/`:
 *   npm run verify:money
 *
 * If this disagrees with the feature file, one of the two is wrong and both are
 * customer-facing — hence a check rather than a comment.
 */
import {
  calculateQuoteAmounts,
  percentOfBalance,
  inverseRate,
  rateDriftPercent,
  add,
  eq,
  decimalPlaces,
} from '../.money-check/money.js'

const RUB_USDT = '0.010638297872'
const RUB = 2
const USDT = 6
const feeRubUsdt = { mode: 'INCLUDED_IN_SOURCE', percent: '0.35', minFee: '10.00', maxFee: null, networkFee: '0' }
const feeUsdtRub = { mode: 'INCLUDED_IN_SOURCE', percent: '0.35', minFee: '0.50', maxFee: null, networkFee: '0' }

let failures = 0
function expect(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        expected ${expected}\n        actual   ${actual}`)
}

function quote(from, rate, policy, fromDec, toDec) {
  return calculateQuoteAmounts({ rawFromAmount: from, rate, policy, fromDecimals: fromDec, toDecimals: toDec })
}

console.log('--- RUB -> USDT, rate 0.010638297872, fee 0.35% min 10.00 ---')
for (const [amount, fee, receive] of [
  ['10000.00', '35.00', '106.010638'],
  ['6362.50', '22.27', '67.449255'],
  ['12725.00', '44.54', '134.898510'],
  ['19087.50', '66.81', '202.347765'],
  ['25450.00', '89.08', '269.797021'],
]) {
  const r = quote(amount, RUB_USDT, feeRubUsdt, RUB, USDT)
  expect(`${amount} RUB -> fee`, r.feeAmount, fee)
  expect(`${amount} RUB -> receive`, r.toAmount, receive)
}

console.log('\n--- percent chips over available 25450.00 RUB ---')
for (const [pct, expected] of [
  [25, '6362.50'],
  [50, '12725.00'],
  [75, '19087.50'],
  [100, '25450.00'],
]) {
  expect(`${pct}%`, percentOfBalance('25450.00', pct, RUB), expected)
}

console.log('\n--- rate drift scenario, 1 USDT = 94.50 RUB ---')
const drifted = '0.010582010582'
expect('drift %', rateDriftPercent(RUB_USDT, drifted).toFixed(3), '0.529')
expect('drifted receive', quote('10000.00', drifted, feeRubUsdt, RUB, USDT).toAmount, '105.449735')

console.log('\n--- swap USDT -> RUB, rate 93.60, minFee 0.50 USDT applies ---')
const swapped = quote('106.010638', '93.60', feeUsdtRub, USDT, RUB)
expect('swap fee (minimum wins)', swapped.feeAmount, '0.500000')
expect('swap net', swapped.netFromAmount, '105.510638')
expect('swap receive', swapped.toAmount, '9875.79')

console.log('\n--- invariants ---')
const inv = quote('10000.00', RUB_USDT, feeRubUsdt, RUB, USDT)
// Checked with decimal arithmetic, not `Number`: verifying an exact-money
// invariant through the very type the canon forbids would prove nothing.
// `eq`, not string equality: `add` normalises "10000.00" to "10000", which is
// the same amount written differently.
expect('I1 fee + net == from', String(eq(add(inv.feeAmount, inv.netFromAmount), inv.fromAmount)), 'true')
expect('I5 fromAmount precision', String(decimalPlaces(inv.fromAmount) <= RUB), 'true')
expect('I5 toAmount precision', String(decimalPlaces(inv.toAmount) <= USDT), 'true')
expect('inverse rate display', inverseRate(RUB_USDT, 2), '94.00')

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
