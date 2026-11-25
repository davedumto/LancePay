import { USDC_ASSET } from './stellar';

/**
 * Asset metadata for LancePay.
 *
 * The USDC issuer is derived from USDC_ASSET in lib/stellar.ts so there is a
 * single source of truth — when NEXT_PUBLIC_USDC_ISSUER is unset, USDC_ASSET
 * falls back to the configured/testnet issuer and the metadata below always
 * matches it (previously the metadata issuer was undefined in that case, so
 * real USDC balances rendered as unverified tokens).
 *
 * Icons are self-hosted under /public/icons rather than hotlinked.
 */
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
        icon: "/icons/xlm.png",
        isVerified: true
    },
    {
        code: "USDC",
        issuer: USDC_ASSET.getIssuer(),
        name: "USD Coin",
        domain: "centre.io",
        icon: "/icons/usdc.png",
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
