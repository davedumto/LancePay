import { describe, it, expect, vi, afterEach } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import { resolveStellarNetworkConfig } from "@/lib/stellar-network";

const TESTNET_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const MAINNET_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function env(vars: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return vars as NodeJS.ProcessEnv;
}

describe("resolveStellarNetworkConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to testnet with testnet horizon and USDC issuer", () => {
    const cfg = resolveStellarNetworkConfig(env({}));
    expect(cfg.network).toBe("testnet");
    expect(cfg.networkPassphrase).toBe(Networks.TESTNET);
    expect(cfg.horizonUrl).toBe("https://horizon-testnet.stellar.org");
    expect(cfg.usdcIssuer).toBe(TESTNET_ISSUER);
    expect(cfg.usdcCode).toBe("USDC");
  });

  it("uses the legacy NEXT_PUBLIC_STELLAR_NETWORK alias when canonical is unset", () => {
    const cfg = resolveStellarNetworkConfig(
      env({ NEXT_PUBLIC_STELLAR_NETWORK: "testnet" }),
    );
    expect(cfg.network).toBe("testnet");
  });

  it("warns and prefers STELLAR_NETWORK when both vars disagree", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = resolveStellarNetworkConfig(
      env({
        STELLAR_NETWORK: "testnet",
        NEXT_PUBLIC_STELLAR_NETWORK: "mainnet",
        USDC_ISSUER: MAINNET_ISSUER,
        STELLAR_HORIZON_URL: "https://horizon.stellar.org",
      }),
    );
    expect(cfg.network).toBe("testnet");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("disagree"));
  });

  it("does not warn when both vars agree", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = resolveStellarNetworkConfig(
      env({
        STELLAR_NETWORK: "mainnet",
        NEXT_PUBLIC_STELLAR_NETWORK: "mainnet",
        STELLAR_HORIZON_URL: "https://horizon.stellar.org",
        USDC_ISSUER: MAINNET_ISSUER,
      }),
    );
    expect(cfg.network).toBe("mainnet");
    expect(warn).not.toHaveBeenCalled();
  });

  it("throws on mainnet without USDC issuer", () => {
    expect(() =>
      resolveStellarNetworkConfig(
        env({
          STELLAR_NETWORK: "mainnet",
          STELLAR_HORIZON_URL: "https://horizon.stellar.org",
        }),
      ),
    ).toThrow(/USDC_ISSUER/);
  });

  it("throws on mainnet without Horizon URL", () => {
    expect(() =>
      resolveStellarNetworkConfig(
        env({ STELLAR_NETWORK: "mainnet", USDC_ISSUER: MAINNET_ISSUER }),
      ),
    ).toThrow(/STELLAR_HORIZON_URL/);
  });

  it("resolves mainnet when issuer and horizon are configured", () => {
    const cfg = resolveStellarNetworkConfig(
      env({
        STELLAR_NETWORK: "mainnet",
        STELLAR_HORIZON_URL: "https://horizon.stellar.org",
        USDC_ISSUER: MAINNET_ISSUER,
      }),
    );
    expect(cfg.network).toBe("mainnet");
    expect(cfg.networkPassphrase).toBe(Networks.PUBLIC);
    expect(cfg.horizonUrl).toBe("https://horizon.stellar.org");
    expect(cfg.usdcIssuer).toBe(MAINNET_ISSUER);
  });

  it("accepts 'public' as a mainnet alias", () => {
    const cfg = resolveStellarNetworkConfig(
      env({
        STELLAR_NETWORK: "public",
        NEXT_PUBLIC_STELLAR_HORIZON_URL: "https://horizon.stellar.org",
        NEXT_PUBLIC_USDC_ISSUER: MAINNET_ISSUER,
      }),
    );
    expect(cfg.network).toBe("mainnet");
    expect(cfg.usdcIssuer).toBe(MAINNET_ISSUER);
  });

  it("keeps testnet defaults even when NEXT_PUBLIC issuer is set", () => {
    const cfg = resolveStellarNetworkConfig(
      env({ NEXT_PUBLIC_USDC_ISSUER: MAINNET_ISSUER }),
    );
    expect(cfg.network).toBe("testnet");
    expect(cfg.usdcIssuer).toBe(MAINNET_ISSUER);
  });
});
