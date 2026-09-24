/**
 * SEP-24 (Stellar Ecosystem Proposal 24) utilities for interactive anchor sessions.
 * Handles communication with anchor servers to initiate withdrawal flows.
 */

import { AnchorId, getAnchorConfig } from './anchors'

export interface Sep24SessionResult {
  jwtToken: string
  interactiveUrl: string
}

/**
 * Initiates a SEP-24 interactive session with an anchor.
 * This calls the anchor's /sep24/transactions/deposit/interactive endpoint
 * to get a JWT token and interactive URL for user interaction.
 *
 * @param anchorId - The anchor identifier (moneygram or yellowcard)
 * @param userId - The user ID initiating the session
 * @returns JWT token and interactive URL
 * @throws Error if anchor configuration is missing or API call fails
 */
export async function initiateSep24Session(
  anchorId: AnchorId,
  userId: string
): Promise<Sep24SessionResult> {
  const config = getAnchorConfig(anchorId)
  if (!config) {
    throw new Error(`Anchor configuration not found for: ${anchorId}`)
  }

  if (!config.clientId || !config.clientSecret) {
    throw new Error(`Anchor credentials not configured for: ${anchorId}`)
  }

  // Build the SEP-24 interactive endpoint URL
  const sep24Endpoint = `${config.sep24Endpoint}/sep24/transactions/deposit/interactive`

  // Prepare authentication header using client credentials
  const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')

  try {
    const response = await fetch(sep24Endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
      },
      body: JSON.stringify({
        userId,
        asset_code: 'USDC',
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(
        `SEP-24 endpoint returned ${response.status}: ${
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
