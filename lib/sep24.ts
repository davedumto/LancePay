/**
 * SEP-24 (Stellar Ecosystem Proposal 24) utilities for interactive anchor sessions.
 *
 * Direction selects the SEP-24 endpoint (relative to the anchor's
 * TRANSFER_SERVER_SEP0024):
 * - 'deposit'  → POST /transactions/deposit/interactive
 * - 'withdraw' → POST /transactions/withdraw/interactive
 *
 * Anchor sessions opened by this app are for cash-out (withdrawal) flows —
 * pass direction: 'withdraw'. A 'deposit' direction starts a deposit flow and
 * must only be used for on-ramp sessions.
 *
 * Authentication uses SEP-10: a challenge is exchanged for a JWT which is
 * sent as `Authorization: Bearer` (see lib/sep10.ts).
 */

import { AnchorId, getAnchorConfig } from './anchors'
import { getSep10Token } from './sep10'

export type Sep24Direction = 'deposit' | 'withdraw'

export const SEP24_DIRECTIONS: readonly Sep24Direction[] = ['deposit', 'withdraw']

export interface Sep24SessionParams {
  direction: Sep24Direction
  /** SEP-24 asset_code (e.g. 'USDC', 'NGN'). Defaults to 'USDC'. */
  assetCode?: string
  /** SEP-24 account — the user's account identifier at the anchor. */
  account?: string
  /** Optional amount for the session. */
  amount?: string | number
  /** Optional memo forwarded to the anchor. */
  memo?: string
}

export interface Sep24SessionResult {
  jwtToken: string
  interactiveUrl: string
}

function isSep24Direction(value: unknown): value is Sep24Direction {
  return value === 'deposit' || value === 'withdraw'
}

/**
 * Initiates a SEP-24 interactive session with an anchor.
 * Calls the anchor's /transactions/{direction}/interactive endpoint —
 * 'deposit' or 'withdraw' selects the matching SEP-24 flow.
 *
 * The request body sends the fields SEP-24 requires: asset_code, account and
 * amount. The custom `userId` field is NOT sent — SEP-24 identifies sessions
 * via memo, not provider-specific fields.
 *
 * @param anchorId - The anchor identifier (moneygram or yellowcard)
 * @param params - Session parameters including the required direction
 * @returns JWT token and interactive URL
 * @throws Error if anchor configuration is missing, direction is invalid, the
 *   SEP-10 token cannot be obtained, or the API call fails
 */
export async function initiateSep24Session(
  anchorId: AnchorId,
  params: Sep24SessionParams
): Promise<Sep24SessionResult> {
  const config = await getAnchorConfig(anchorId)
  if (!config) {
    throw new Error(`Anchor configuration not found for: ${anchorId}`)
  }

  if (!isSep24Direction(params.direction)) {
    throw new Error(`Invalid SEP-24 direction: ${String(params.direction)}`)
  }

  // SEP-10 web authentication: exchange a signed challenge for a bearer JWT.
  const sep10Token = await getSep10Token(config, params.account)

  // Build the SEP-24 interactive endpoint URL for the requested direction.
  // TRANSFER_SERVER_SEP0024 is the server root; endpoints are relative to it.
  const sep24Endpoint = `${config.sep24Endpoint}/transactions/${params.direction}/interactive`

  // SEP-24 field names (snake_case), not custom provider fields.
  const body: Record<string, unknown> = {
    asset_code: params.assetCode ?? 'USDC',
  }
  if (params.account) {
    body.account = params.account
  }
  if (params.amount !== undefined && params.amount !== '') {
    body.amount = String(params.amount)
  }
  if (params.memo) {
    body.memo = params.memo
  }

  try {
    const response = await fetch(sep24Endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sep10Token}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(
        `SEP-24 ${params.direction} endpoint returned ${response.status}: ${
          errorData.error || errorData.message || 'Unknown error'
        }`
      )
    }

    const data = await response.json()

    if (!data.jwt || !data.interactive_url) {
      throw new Error('SEP-24 response missing required fields: jwt or interactive_url')
    }

    return {
      jwtToken: data.jwt,
      interactiveUrl: data.interactive_url,
    }
  } catch (error) {
    if (error instanceof Error) {
      throw error
    }
    throw new Error('Failed to initiate SEP-24 session')
  }
}
