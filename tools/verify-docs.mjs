/**
 * Cross-artefact consistency checks.
 *
 * The delivery is five documents plus a prototype that all restate the same
 * facts — error codes, field names, statuses, amounts. Restated facts drift.
 * This script makes the drift fail loudly instead of being discovered by a
 * reader.
 *
 * Run from `tools/`:  npm run verify
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
let checks = 0

function check(label, ok, detail = '') {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`)
}

function section(title) {
  console.log(`\n--- ${title} ---`)
}

// ---------------------------------------------------------------------------
// 1. Every OpenAPI document parses and declares 3.1
// ---------------------------------------------------------------------------

section('OpenAPI documents parse and declare 3.1')

const specPaths = [
  'docs/api/exchange-orders.openapi.yaml',
  ...readdirSync(join(root, 'docs/api/integrations'))
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => `docs/api/integrations/${f}`),
]

const specs = new Map()

for (const path of specPaths) {
  let doc = null
  let error = ''
  try {
    doc = parse(read(path))
  } catch (e) {
    error = String(e.message).split('\n')[0]
  }
  check(`${basename(path)} parses`, doc !== null, error)
  if (!doc) continue
  specs.set(path, doc)
  check(`${basename(path)} is OpenAPI 3.1`, /^3\.1\.\d+$/.test(doc.openapi ?? ''), `openapi: ${doc.openapi}`)
  check(`${basename(path)} has info.title and version`, Boolean(doc.info?.title && doc.info?.version))
  check(
    `${basename(path)} declares paths or webhooks`,
    Object.keys(doc.paths ?? {}).length > 0 || Object.keys(doc.webhooks ?? {}).length > 0,
  )
}

// ---------------------------------------------------------------------------
// 2. The main API exposes the endpoints the SDD and the brief promise
// ---------------------------------------------------------------------------

section('Main API surface')

const main = specs.get('docs/api/exchange-orders.openapi.yaml')

if (main) {
  const expected = [
    ['/v1/exchange/assets', 'get'],
    ['/v1/exchange/pairs', 'get'],
    ['/v1/wallet/balances', 'get'],
    ['/v1/exchange/quotes', 'post'],
    ['/v1/exchange/quotes/{quoteId}', 'get'],
    ['/v1/exchange-orders', 'post'],
    ['/v1/exchange-orders/{orderId}', 'get'],
  ]
  for (const [path, method] of expected) {
    check(`${method.toUpperCase()} ${path}`, Boolean(main.paths?.[path]?.[method]))
  }

  const createOrder = main.paths?.['/v1/exchange-orders']?.post
  if (createOrder) {
    const codes = Object.keys(createOrder.responses ?? {})
    for (const code of ['201', '202', '400', '403', '404', '409', '422', '429', '500', '503', '504']) {
      check(`POST /v1/exchange-orders documents ${code}`, codes.includes(code), `has: ${codes.join(', ')}`)
    }
    // Parameters are `$ref`s into components, so the header name lives on the
    // referenced object rather than inline.
    const resolve = (node) => {
      if (!node?.$ref) return node
      const path = node.$ref.replace(/^#\//, '').split('/')
      return path.reduce((acc, key) => acc?.[key], main)
    }
    const params = (createOrder.parameters ?? []).map(resolve).filter(Boolean)
    const idem = params.find((p) => p.name === 'Idempotency-Key')
    check('POST /v1/exchange-orders declares Idempotency-Key', Boolean(idem))
    check('Idempotency-Key is a required header', idem?.in === 'header' && idem?.required === true)
    check(
      'POST /v1/exchange-orders accepts X-Correlation-Id',
      params.some((p) => p.name === 'X-Correlation-Id'),
    )
  }
}

// ---------------------------------------------------------------------------
// 3. Money is never typed as a JSON number
// ---------------------------------------------------------------------------

section('Money is represented as decimal strings, never numbers')

/**
 * Unambiguously monetary — a `number` or `integer` here is always a defect.
 */
const MONEY_FIELD =
  /^(fromAmount|toAmount|feeAmount|netFromAmount|expectedToAmount|rate|expectedRate|inverseRate|available|held|minAmount|maxAmount|minFee|maxFee|networkFee)$/

/**
 * Context-dependent: `total` is a balance in `Balance` and a row count in
 * `PairsResponse`. A count is legitimately `integer`, so these are only flagged
 * when typed as `number`, which is never right for either meaning.
 */
const AMBIGUOUS_FIELD = /^(total|amount|used|remaining|limit)$/

function walkSchemas(node, path, onProperty) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkSchemas(item, `${path}[${i}]`, onProperty))
    return
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const [name, schema] of Object.entries(node.properties)) {
      onProperty(name, schema, `${path}.properties.${name}`)
    }
  }
  for (const [key, value] of Object.entries(node)) {
    walkSchemas(value, `${path}.${key}`, onProperty)
  }
}

const numericMoney = []
for (const [path, doc] of specs) {
  walkSchemas(doc, basename(path), (name, schema, where) => {
    if (!schema || typeof schema !== 'object') return
    const strict = MONEY_FIELD.test(name)
    const ambiguous = AMBIGUOUS_FIELD.test(name)
    if (!strict && !ambiguous) return
    const bad = strict ? schema.type === 'number' || schema.type === 'integer' : schema.type === 'number'
    if (bad) numericMoney.push(`${where} → type: ${schema.type}`)
  })
}
check(
  'no monetary field is declared as number/integer',
  numericMoney.length === 0,
  numericMoney.slice(0, 8).join('\n        '),
)

// ---------------------------------------------------------------------------
// 4. Error catalog is identical across canon, prototype and OpenAPI
// ---------------------------------------------------------------------------

section('Error catalog is consistent across artefacts')

const canon = read('docs/00-canonical-model.md')
const canonCodes = new Set(
  [...canon.matchAll(/^\|\s*`([A-Z][A-Z0-9_]{4,})`\s*\|\s*\d{3}\s*\|/gm)].map((m) => m[1]),
)

const errorsTs = read('prototype/src/domain/errors.ts')
const codeBlock = errorsTs.slice(errorsTs.indexOf('export const ERROR_CODES'), errorsTs.indexOf('] as const'))
const protoCodes = new Set([...codeBlock.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]))

check('canonical model lists error codes', canonCodes.size >= 25, `found ${canonCodes.size}`)
check('prototype lists error codes', protoCodes.size >= 25, `found ${protoCodes.size}`)

const missingInProto = [...canonCodes].filter((c) => !protoCodes.has(c))
const missingInCanon = [...protoCodes].filter((c) => !canonCodes.has(c))
check('every canonical code exists in the prototype', missingInProto.length === 0, missingInProto.join(', '))
check('the prototype invents no extra codes', missingInCanon.length === 0, missingInCanon.join(', '))

const mainYaml = read('docs/api/exchange-orders.openapi.yaml')
const missingInSpec = [...canonCodes].filter((c) => !mainYaml.includes(c))
check('every canonical code appears in the OpenAPI spec', missingInSpec.length === 0, missingInSpec.join(', '))

// ---------------------------------------------------------------------------
// 5. Gherkin references only real error codes and real fixtures
// ---------------------------------------------------------------------------

section('Gherkin feature file')

const feature = read('docs/features/exchange-order.feature')
check('declares Russian language header', feature.startsWith('# language: ru'))

const errorTags = [...feature.matchAll(/@error-([A-Z][A-Z0-9_]+)/g)].map((m) => m[1])
check('feature file tags scenarios with error codes', errorTags.length > 0, `found ${errorTags.length}`)
const unknownTags = [...new Set(errorTags)].filter((c) => !canonCodes.has(c))
check('every @error-* tag is a catalogued code', unknownTags.length === 0, unknownTags.join(', '))

const happy = (feature.match(/@happy/g) ?? []).length
const negative = (feature.match(/@negative/g) ?? []).length
check('at least one happy path', happy >= 1, `found ${happy}`)
check('at least five negative paths (Gherkin Brief)', negative >= 5, `found ${negative}`)

// The seven negative cases the brief names explicitly.
for (const [label, code] of [
  ['insufficient funds', 'INSUFFICIENT_FUNDS'],
  ['rate change', 'RATE_CHANGED'],
  ['minimum amount', 'AMOUNT_BELOW_MINIMUM'],
  ['invalid pair', 'PAIR_NOT_SUPPORTED'],
  ['same assets', 'SAME_ASSET_PAIR'],
  ['rate service down', 'RATE_SERVICE_UNAVAILABLE'],
  ['expired quote', 'QUOTE_EXPIRED'],
  ['invalid amount', 'VALIDATION_ERROR'],
]) {
  check(`covers "${label}"`, feature.includes(code))
}

// ---------------------------------------------------------------------------
// 6. Fixtures agree between the canonical model and the prototype
// ---------------------------------------------------------------------------

section('Fixtures agree between canon and prototype')

const fixtures = read('prototype/src/api/fixtures.ts')
for (const value of ['25450.00', '135.270000', '0.01420000', '0.86000000', '0.010638297872', '93.60']) {
  check(`${value} present in canon`, canon.includes(value))
  check(`${value} present in prototype fixtures`, fixtures.includes(value))
}
check('ETH held balance is non-zero in both', canon.includes('0.10000000') && fixtures.includes("held: '0.10000000'"))

// ---------------------------------------------------------------------------
// 7. Mermaid diagrams use latin node ids
// ---------------------------------------------------------------------------

section('Mermaid diagrams')

for (const path of ['docs/SDD.md', 'docs/UX-UI-Spec.md']) {
  const text = read(path)
  const blocks = [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1])
  check(`${basename(path)} contains mermaid diagrams`, blocks.length > 0, `found ${blocks.length}`)

  // A node id written in Cyrillic is the single most common way these diagrams
  // fail to render. Labels are a different matter — quoted labels, bracketed
  // labels and sequence-message text after the colon are all allowed to be
  // Cyrillic and are stripped before the check.
  const badIds = []
  for (const block of blocks) {
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim()
      if (line.startsWith('%%') || line.startsWith('Note ')) continue

      let stripped = line
        .replace(/"[^"]*"/g, '""')
        .replace(/\[[^\]]*\]/g, '[]')
        .replace(/\{[^}]*\}/g, '{}')
        .replace(/\([^)]*\)/g, '()')

      // Sequence-diagram message text and stateDiagram transition labels live
      // after the first colon.
      if (/(-?->>?|--\)|-->)/.test(stripped)) stripped = stripped.split(':')[0]

      if (/[А-Яа-яЁё]/.test(stripped) && /-->|---|==>|->>/.test(stripped)) badIds.push(line)
    }
  }
  check(`${basename(path)} has no Cyrillic node ids`, badIds.length === 0, badIds.slice(0, 3).join('\n        '))
}

// ---------------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} FAILED`)
  process.exit(1)
}
console.log('ALL DOCUMENT CHECKS PASSED')
