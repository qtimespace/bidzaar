/**
 * S7 — Crypto Provider (mock).
 *
 * Contract: `docs/api/integrations/crypto-provider.yaml`, described in
 * `docs/api/INTEGRATIONS.md` §S7. Critical class: **Degradable**.
 *
 * What the app receives: exchange-side order/liquidity information, slippage
 * estimates, network congestion and per-network confirmation estimates.
 *
 * This is the only external system on the create-order path that may fail
 * without blocking the user: its data enriches the summary (the `Network` row)
 * but does not gate the decision. On failure the caller gets `null` and the
 * screen simply omits the enrichment.
 */

import { NETWORK_STATUS } from '../fixtures'
import { delay } from '../transport'

export interface NetworkInfo {
  network: string
  congestion: 'LOW' | 'MEDIUM' | 'HIGH'
  estimatedConfirmationSec: number
  /** Zero for an internal exchange — no on-chain transfer takes place (canonical §5.5). */
  networkFee: string
}

export async function getNetworkInfo(network: string | undefined): Promise<NetworkInfo | null> {
  if (!network) return null
  await delay(70)

  const status = NETWORK_STATUS[network]
  if (!status) return null

  return {
    network,
    congestion: status.congestion,
    estimatedConfirmationSec: status.estimatedConfirmationSec,
    networkFee: '0',
  }
}
