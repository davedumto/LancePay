/**
 * Provider Factory
 *
 * Creates and returns the appropriate virtual account provider based on configuration
 */

import { IVirtualAccountProvider, ProviderConfig } from "./provider-interface";
import { KorapayProvider } from "./providers/korapay";
import { MonnifyProvider } from "./providers/monnify";
import { PaystackProvider } from "./providers/paystack";

/**
 * Get the active virtual account provider based on environment configuration
 */
export function getVirtualAccountProvider(): IVirtualAccountProvider {
  const providerName = process.env.VIRTUAL_ACCOUNT_PROVIDER?.toLowerCase();

  switch (providerName) {
    case "korapay":
      return createKorapayProvider();

    case "monnify":
      return createMonnifyProvider();

    case "paystack":
      return createPaystackProvider();

    default:
      throw new Error(
        `Invalid or missing VIRTUAL_ACCOUNT_PROVIDER: ${providerName}. ` +
          `Supported values: korapay, monnify, paystack`,
      );
  }
}

/**
 * Create Korapay provider instance
 */
function createKorapayProvider(): KorapayProvider {
  const apiKey = process.env.KORAPAY_PUBLIC_KEY;
  const secretKey = process.env.KORAPAY_SECRET_KEY;
  const webhookSecret = process.env.KORAPAY_WEBHOOK_SECRET;

  if (!apiKey || !secretKey || !webhookSecret) {
    throw new Error(
      "Missing Korapay configuration. Required env vars: " +
        "KORAPAY_PUBLIC_KEY, KORAPAY_SECRET_KEY, KORAPAY_WEBHOOK_SECRET",
    );
  }

  return new KorapayProvider({
    apiKey,
    secretKey,
    webhookSecret,
    baseUrl: process.env.KORAPAY_API_URL, // Optional, defaults to production
  });
}

/**
 * Create Monnify provider instance
 */
function createMonnifyProvider(): MonnifyProvider {
  const apiKey = process.env.MONNIFY_API_KEY;
  const secretKey = process.env.MONNIFY_SECRET_KEY;
  const contractCode = process.env.MONNIFY_CONTRACT_CODE;
  const webhookSecret = process.env.MONNIFY_WEBHOOK_SECRET;

  if (!apiKey || !secretKey || !contractCode || !webhookSecret) {
    throw new Error(
      "Missing Monnify configuration. Required env vars: " +
        "MONNIFY_API_KEY, MONNIFY_SECRET_KEY, MONNIFY_CONTRACT_CODE, MONNIFY_WEBHOOK_SECRET",
    );
  }

  return new MonnifyProvider({
    apiKey,
    secretKey,
    contractCode,
    webhookSecret,
    baseUrl: process.env.MONNIFY_API_URL, // Optional, defaults to production
  });
}

/**
 * Create Paystack provider instance
 */
function createPaystackProvider(): PaystackProvider {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  const webhookSecret = process.env.PAYSTACK_WEBHOOK_SECRET;

  if (!secretKey || !webhookSecret) {
    throw new Error(
      "Missing Paystack configuration. Required env vars: " +
        "PAYSTACK_SECRET_KEY, PAYSTACK_WEBHOOK_SECRET",
    );
  }

  return new PaystackProvider({
    secretKey,
    webhookSecret,
    baseUrl: process.env.PAYSTACK_API_URL, // Optional, defaults to production
  });
}

/**
 * Validate provider configuration on startup
 * Call this during app initialization to fail fast if config is invalid
 */
export function validateProviderConfig(): void {
  try {
    getVirtualAccountProvider();
    console.log("✅ Virtual account provider configuration validated");
  } catch (error) {
    console.error("❌ Virtual account provider configuration error:", error);
    throw error;
  }
}
