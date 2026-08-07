/**
 * S8 — Order Service (mock).
 *
 * Contract: `docs/api/integrations/order-service.yaml`, described in
 * `docs/api/INTEGRATIONS.md` §S8. Critical class: Blocking.
 *
 * What the app receives: the registered order with its assigned `orderId` and
 * status. Used at validation step 19 (canonical §6) — the last one.
 */

import type { ExchangeOrder, OrderStatus, Quote } from '@/domain/types'
import { getScenario } from '../scenarios'
import { delay, fail, nowIso, ulid } from '../transport'

/** Timeout 2000 ms. Idempotent by key, so a retry is safe here — unlike the hold. */
export async function registerOrder(input: {
  quote: Quote
  holdId: string
  status: OrderStatus
  idempotencyKey: string
  correlationId: string
}): Promise<ExchangeOrder> {
  await delay(160)

  if (getScenario() === 'EXCHANGE_DOWN') {
    fail('EXCHANGE_SERVICE_UNAVAILABLE', 'Order registration is temporarily unavailable', {
      instance: '/v1/exchange-orders',
      correlationId: input.correlationId,
    })
  }

  const now = Date.now()
  const { quote } = input

  return {
    orderId: `ord_${ulid(now)}`,
    status: input.status,
    quoteId: quote.quoteId,
    fromAsset: quote.fromAsset,
    toAsset: quote.toAsset,
    fromAmount: quote.fromAmount,
    feeAmount: quote.feeAmount,
    toAmount: quote.toAmount,
    rate: quote.rate,
    holdId: input.holdId,
    createdAt: nowIso(),
    estimatedCompletionAt: new Date(now + 30_000).toISOString(),
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
  }
}
