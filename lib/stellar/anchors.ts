/**
 * Anchor Discovery and Configuration (SEP-1)
 * 
 * Handles stellar.toml discovery and anchor endpoint configuration
 * for SEP-10/SEP-24 flows with MoneyGram and Yellow Card.
 */

export type AnchorId = 'moneygram' | 'yellowcard';

export interface AnchorConfig {
  id: AnchorId;
  name: string;
  description: string;
  domain: string;
  logo: string;
  supportedAssets: string[];
  withdrawTypes: ('bank_transfer' | 'cash')[];
  countries: string[];
}

export interface AnchorTomlInfo {
  webAuthEndpoint: string;
  transferServerSep24: string;
  signingKey: string;
  networkPassphrase?: string;
}

export interface ResolvedAnchor extends AnchorConfig {
  toml: AnchorTomlInfo;
}

/**
 * Static anchor configurations
 */
export const ANCHOR_CONFIGS: Record<AnchorId, AnchorConfig> = {
  moneygram: {
    id: 'moneygram',
    name: 'MoneyGram',
    description: 'Cash pickup at MoneyGram locations worldwide',
    domain: 'stellar.moneygram.com',
    logo: '/anchors/moneygram-logo.svg',
    supportedAssets: ['USDC'],
    withdrawTypes: ['cash'],
    countries: ['NG', 'KE', 'PH', 'US', 'CA', 'GB'],
  },
  yellowcard: {
    id: 'yellowcard',
    name: 'Yellow Card',
    description: 'Bank transfer to Nigerian bank accounts',
    domain: 'stellar.yellowcard.io',
    logo: '/anchors/yellowcard-logo.svg',
    supportedAssets: ['USDC'],
    withdrawTypes: ['bank_transfer'],
    countries: ['NG', 'KE', 'GH', 'ZA', 'TZ'],
  },
};

/**
 * Cache for parsed stellar.toml data
 */
const tomlCache = new Map<AnchorId, { data: AnchorTomlInfo; expiresAt: number }>();
const TOML_CACHE_TTL = 3600000; // 1 hour

/**
 * Parse stellar.toml content into structured data
 */
function parseToml(content: string): Partial<AnchorTomlInfo> {
  const result: Partial<AnchorTomlInfo> = {};
  
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    
    const [key, ...valueParts] = trimmed.split('=');
    const value = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
    
    switch (key.trim()) {
      case 'WEB_AUTH_ENDPOINT':
        result.webAuthEndpoint = value;
        break;
      case 'TRANSFER_SERVER_SEP0024':
        result.transferServerSep24 = value;
        break;
      case 'SIGNING_KEY':
        result.signingKey = value;
        break;
      case 'NETWORK_PASSPHRASE':
        result.networkPassphrase = value;
        break;
    }
  }
  
  return result;
}

/**
 * Fetch and parse stellar.toml from an anchor's domain
 */
export async function fetchStellarToml(anchorId: AnchorId): Promise<AnchorTomlInfo> {
  // Check cache first
  const cached = tomlCache.get(anchorId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  
  const config = ANCHOR_CONFIGS[anchorId];
  if (!config) {
    throw new Error(`Unknown anchor: ${anchorId}`);
  }
  
  const tomlUrl = `https://${config.domain}/.well-known/stellar.toml`;
  
  try {
    const response = await fetch(tomlUrl, {
      headers: {
        'Accept': 'text/plain',
      },
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch stellar.toml: ${response.status}`);
    }
    
    const content = await response.text();
    const parsed = parseToml(content);
    
    // Validate required fields
    if (!parsed.webAuthEndpoint || !parsed.transferServerSep24 || !parsed.signingKey) {
      throw new Error(`Invalid stellar.toml: missing required fields`);
    }
    
    const tomlInfo: AnchorTomlInfo = {
      webAuthEndpoint: parsed.webAuthEndpoint,
      transferServerSep24: parsed.transferServerSep24,
      signingKey: parsed.signingKey,
      networkPassphrase: parsed.networkPassphrase,
    };
    
    // Cache the result
    tomlCache.set(anchorId, {
      data: tomlInfo,
      expiresAt: Date.now() + TOML_CACHE_TTL,
    });
    
    return tomlInfo;
  } catch (error) {
    console.error(`Error fetching stellar.toml for ${anchorId}:`, error);
    throw new Error(`Failed to discover anchor ${anchorId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Get fully resolved anchor with TOML info
 */
export async function getAnchor(anchorId: AnchorId): Promise<ResolvedAnchor> {
  const config = ANCHOR_CONFIGS[anchorId];
  if (!config) {
    throw new Error(`Unknown anchor: ${anchorId}`);
  }
  
  const toml = await fetchStellarToml(anchorId);
  
  return {
    ...config,
    toml,
  };
}

/**
 * Get all available anchors for a given country
 */
export function getAnchorsForCountry(countryCode: string): AnchorConfig[] {
  return Object.values(ANCHOR_CONFIGS).filter(
    anchor => anchor.countries.includes(countryCode)
  );
}

/**
 * Get anchors that support a specific withdrawal type
 */
export function getAnchorsForWithdrawType(withdrawType: 'bank_transfer' | 'cash'): AnchorConfig[] {
  return Object.values(ANCHOR_CONFIGS).filter(
    anchor => anchor.withdrawTypes.includes(withdrawType)
  );
}

/**
 * Clear the TOML cache (useful for testing or cache invalidation)
 */
export function clearTomlCache(): void {
  tomlCache.clear();
}
