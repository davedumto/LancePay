
export interface AssetMetadata {
    code: string;
    issuer?: string;
    name: string;
    domain?: string;
    icon?: string;
    isVerified?: boolean;
}

// Curated list of assets for LancePay
export const KNOWN_ASSETS: AssetMetadata[] = [
    {
        code: "XLM",
        name: "Stellar Lumens",
        domain: "stellar.org",
        icon: "https://cryptologos.cc/logos/stellar-xlm-logo.png",
        isVerified: true
    },
    {
        code: "USDC",
        issuer: process.env.NEXT_PUBLIC_USDC_ISSUER, 
        name: "USD Coin",
        domain: "centre.io",
        icon: "https://cryptologos.cc/logos/usd-coin-usdc-logo.png",
        isVerified: true
    }
];

/**
 * Resolve metadata for a given asset
 * @param code Asset code
 * @param issuer Asset issuer (optional for native)
 * @returns AssetMetadata
 */
export function resolveAssetMetadata(code: string, issuer?: string): AssetMetadata {
    if (code === "XLM" || !issuer) {
        return KNOWN_ASSETS.find(a => a.code === "XLM")!;
    }

    const known = KNOWN_ASSETS.find(
        a => a.code === code && a.issuer === issuer
    );

    if (known) return known;

    // Fallback for unknown assets
    return {
        code,
        issuer,
        name: code, // Default to code if name unknown
        isVerified: false
    };
}
