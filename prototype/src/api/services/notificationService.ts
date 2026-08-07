/**
 * S9 — Notification Service (mock).
 *
 * Contract: `docs/api/integrations/notifications.yaml`, described in
 * `docs/api/INTEGRATIONS.md` §S9. Critical class: **Non-blocking**.
 *
 * The order is already created and the funds already reserved by the time this
 * runs. Letting a notification failure surface as an error would tell the user
 * their exchange failed when it did not — so this function swallows everything
 * and only logs. In production the failed delivery goes to a retry queue.
 */

import type { ExchangeOrder } from '@/domain/types'
import { delay } from '../transport'

export type NotificationChannel = 'EMAIL' | 'PUSH' | 'TELEGRAM'

export interface NotificationReceipt {
  notificationId: string
  channel: NotificationChannel
  status: 'QUEUED' | 'SENT' | 'FAILED'
}

export function notifyOrderCreated(order: ExchangeOrder): void {
  // Fire and forget on purpose — the caller must not await this.
  void (async () => {
    try {
      await delay(40)
      console.info('[S9 notifications] order.created queued', {
        orderId: order.orderId,
        correlationId: order.correlationId,
        // Amounts are intentionally NOT logged: canonical §7 / SDD §17 forbid
        // writing monetary values next to identifiers in plain logs.
      })
    } catch {
      // Swallowed by design. Delivery is retried out of band.
    }
  })()
}
