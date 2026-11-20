import { Networks } from "@stellar/stellar-sdk";

/**
 * Single source of truth for the Stellar network configuration.
 *
 * Canonical environment variables (server-side):
 * - `STELLAR_NETWORK`        — `testnet` (default) or `mainnet`/`public`
 * - `STELLAR_HORIZON_URL`    — Horizon endpoint
 * - `USDC_ISSUER`            — USDC asset issuer strkey
 * - `USDC_CODE`              — USDC asset code (default `USDC`)
 *
 * The legacy `NEXT_PUBLIC_*` variants are accepted as aliases so existing
 * deployments keep working. When both the canonical and legacy network
 * variables are set and disagree, a warning is logged and the canonical
 * `STELLAR_NETWORK` value wins.
 *
 * On `mainnet` there are no safe defaults: a missing `STELLAR_HORIZON_URL`
 * (or `NEXT_PUBLIC_STELLAR_HORIZON_URL`) or `USDC_ISSUER` (or
 * `NEXT_PUBLIC_USDC_ISSUER`) throws at module load rather than silently
 * signing payments against testnet assets. Testnet keeps its defaults.
 */

export type StellarNetworkName = "testnet" | "mainnet";

export interface StellarNetworkConfig {
  network: StellarNetworkName;
  /** Value to pass as `networkPassphrase` in transaction builds. */
  networkPassphrase: string;
  horizonUrl: string;
  usdcIssuer: string;
  usdcCode: string;
}

const TESTNET_HORIZON_URL = "https://horizon-testnet.stellar.org";
const TESTNET_USDC_ISSUER =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function normalizeNetwork(raw: string | undefined): StellarNetworkName | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (value === "mainnet" || value === "public") return "mainnet";
  if (value === "testnet") return "testnet";
  return null;
}

function firstSet(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function resolveStellarNetworkConfig(
  env: NodeJS.ProcessEnv = process.env,
): StellarNetworkConfig {
  const canonicalRaw = env.STELLAR_NETWORK;
  const aliasRaw = env.NEXT_PUBLIC_STELLAR_NETWORK;

  const canonical = normalizeNetwork(canonicalRaw);
  const alias = normalizeNetwork(aliasRaw);

  if (canonicalRaw?.trim() && aliasRaw?.trim() && canonical && alias && canonical !== alias) {
    console.warn(
      `[stellar-network] STELLAR_NETWORK="${canonicalRaw}" and ` +
        `NEXT_PUBLIC_STELLAR_NETWORK="${aliasRaw}" disagree; ` +
        `using STELLAR_NETWORK (${canonical}).`,
    );
  }

  const network = canonical ?? alias ?? "testnet";
  const isMainnet = network === "mainnet";

  const horizonUrl = firstSet(
    env.STELLAR_HORIZON_URL,
    env.NEXT_PUBLIC_STELLAR_HORIZON_URL,
    isMainnet ? undefined : TESTNET_HORIZON_URL,
  );
  const usdcIssuer = firstSet(
    env.USDC_ISSUER,
    env.NEXT_PUBLIC_USDC_ISSUER,
    isMainnet ? undefined : TESTNET_USDC_ISSUER,
  );
  const usdcCode = firstSet(env.USDC_CODE, env.NEXT_PUBLIC_USDC_CODE) ?? "USDC";

  if (isMainnet) {
    const missing: string[] = [];
    if (!horizonUrl) {
      missing.push("STELLAR_HORIZON_URL (or NEXT_PUBLIC_STELLAR_HORIZON_URL)");
    }
    if (!usdcIssuer) {
      missing.push("USDC_ISSUER (or NEXT_PUBLIC_USDC_ISSUER)");
    }
    if (missing.length > 0) {
      throw new Error(
        `Stellar mainnet requires explicit configuration; missing: ${missing.join(", ")}. ` +
          "Refusing to fall back to testnet defaults on mainnet.",
      );
    }
  }

  return {
    network,
    networkPassphrase: isMainnet ? Networks.PUBLIC : Networks.TESTNET,
    horizonUrl: horizonUrl!,
    usdcIssuer: usdcIssuer!,
    usdcCode,
  };
}

/** Resolved once at module load; throws on unsafe mainnet configuration. */
export const STELLAR_NETWORK_CONFIG = resolveStellarNetworkConfig();
