import { AssetBalance } from "./stellar";
import { AssetMetadata } from "./assets";

export interface AssetPrice {
    price: number;
    change24h?: number;
    currency: string;
}

const COINGECKO_API_URL = process.env.COINGECKO_API_URL;

// Map Stellar asset codes to CoinGecko IDs
const ASSET_ID_MAP: Record<string, string> = {
    "XLM": "stellar",
    "USDC": "usd-coin",
    "AQUA": "aquarius",
    "yXLM": "stellar", // Using XLM price as proxy
    "YUSDC": "usd-coin",
    "BTC": "bitcoin",
    "ETH": "ethereum",

};

// Fallback prices for things not on CoinGecko or stablecoins we want to force
const FALLBACK_PRICES: Record<string, number> = {
    "ARST": 0.001, 
    "BRL": 0.18,   
    "GHS": 0.08,   
    "KES": 0.007,  
};

/**
 * Get prices for multiple assets in a single batch
 * @param assets Array of { code, issuer }
 * @param currency Target currency (default USD)
 */
export async function getAssetPrices(
    assets: { code: string; issuer?: string }[],
    currency: string = "USD"
): Promise<Record<string, AssetPrice>> {
    const results: Record<string, AssetPrice> = {};
    const idsToFetch: string[] = [];
    const codeToId: Record<string, string> = {};

    // 1. Resolve IDs
    for (const asset of assets) {
        const code = asset.code;
        // Check map
        if (ASSET_ID_MAP[code]) {
            const id = ASSET_ID_MAP[code];
            idsToFetch.push(id);
            codeToId[code] = id;
        } else if (code === 'USDC') {
            // Redundant safety, technically covered by map/fallback usually
            results[code] = { price: 1.0, currency, change24h: 0 };
        } else {
            // Fallback or 0
            results[code] = {
                price: FALLBACK_PRICES[code] || 0,
                currency,
                change24h: 0
            };
        }
    }

    // 2. Fetch from CoinGecko
    if (idsToFetch.length > 0) {
        try {
            const uniqueIds = Array.from(new Set(idsToFetch)).join(",");
            const targetCurrency = currency.toLowerCase(); 

            const response = await fetch(
                `${COINGECKO_API_URL}/simple/price?ids=${uniqueIds}&vs_currencies=${targetCurrency}&include_24hr_change=true`
            );

            if (!response.ok) {
                console.error("CoinGecko API error:", response.statusText);
            } else {
                const data = await response.json();

                // 3. Map results back
                for (const asset of assets) {
                    const code = asset.code;
                    const id = codeToId[code];

                    if (id && data[id]) {
                        results[code] = {
                            price: data[id][targetCurrency] || 0,
                            change24h: data[id][`${targetCurrency}_24h_change`] || 0,
                            currency
                        };
                    }
                }
            }
        } catch (error) {
            console.error("Error fetching prices from CoinGecko:", error);
        }
    }

    return results;
}

/**
 * Get the current price for an asset in the preferred currency (default USD)
 * @param code Asset code
 * @param issuer Asset issuer
 * @param currency Target currency (only USD supported for now)
 * @returns AssetPrice
 */
export async function getAssetPrice(
    code: string,
    issuer: string | undefined,
    currency: string = "USD"
): Promise<AssetPrice> {
    const prices = await getAssetPrices([{ code, issuer }], currency);
    return prices[code];
}

/**
 * Calculate the total value of a portfolio
 * @param balances List of asset balances
 * @returns Total value in USD
 */
export async function calculatePortfolioValue(
    balances: AssetBalance[]
): Promise<number> {
    let total = 0;

    for (const balance of balances) {
        // Skip liquidity pool shares for now
        if (balance.asset_type === 'liquidity_pool_shares') continue;

        const code = balance.asset_code || 'XLM';
        const amount = parseFloat(balance.balance);

        const priceData = await getAssetPrice(code, balance.asset_issuer);
        total += amount * priceData.price;
    }

    return total;
}
