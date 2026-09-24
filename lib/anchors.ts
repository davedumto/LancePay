/**
 * Anchor configuration for SEP-24 interactive withdrawals.
 * Supported anchors: MoneyGram and Yellowcard
 */

export const SUPPORTED_ANCHORS = ['moneygram', 'yellowcard'] as const

export type AnchorId = typeof SUPPORTED_ANCHORS[number]

/**
 * Type guard to validate if a string is a supported anchor ID.
 */
export function isSupportedAnchor(id: string): id is AnchorId {
  return SUPPORTED_ANCHORS.includes(id as AnchorId)
}

/**
 * Get anchor configuration by ID.
 * Returns null if anchor is not supported.
 */
export function getAnchorConfig(anchorId: AnchorId): AnchorConfig | null {
  const configs: Record<AnchorId, AnchorConfig> = {
    moneygram: {
      id: 'moneygram',
      name: 'MoneyGram',
      sep24Endpoint: process.env.MONEYGRAM_SEP24_ENDPOINT || 'https://api.stellar.moneygram.com',
      clientId: process.env.MONEYGRAM_CLIENT_ID,
      clientSecret: process.env.MONEYGRAM_CLIENT_SECRET,
    },
    yellowcard: {
      id: 'yellowcard',
      name: 'Yellowcard',
      sep24Endpoint: process.env.YELLOWCARD_SEP24_ENDPOINT || 'https://api.stellar.yellowcard.io',
      clientId: process.env.YELLOWCARD_CLIENT_ID,
      clientSecret: process.env.YELLOWCARD_CLIENT_SECRET,
    },
  }

  return configs[anchorId]
}

export interface AnchorConfig {
  id: AnchorId
  name: string
  sep24Endpoint: string
  clientId?: string
  clientSecret?: string
}
