import { Horizon, Networks, Asset, Keypair, TransactionBuilder, Operation, StrKey, Transaction, Memo, AuthFlag } from "@stellar/stellar-sdk";

/**
 * Stellar Network Configuration
 */
export const STELLAR_NETWORK: string =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet"
    ? Networks.PUBLIC
    : Networks.TESTNET;

export const HORIZON_URL: string =
  process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL ||
  "https://horizon-testnet.stellar.org";

export const server = new Horizon.Server(HORIZON_URL);

/**
 * USDC Asset
 * Fallback to testnet USDC issuer if not configured
 */
const USDC_ISSUER = process.env.NEXT_PUBLIC_USDC_ISSUER || 
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"; // Testnet USDC issuer

/**
 * Type definition for account balances
 */
export interface AccountBalance {
  xlm: string; // Native XLM balance
  usdc: string; // USDC balance
}

/**
 * Typed Stellar errors
 */
export type StellarError =
  | { type: "invalid_address"; message: string }
  | { type: "network_error"; message: string }
  | { type: "payment_failed"; message: string };

/**
 * Type definition for Stellar SDK error responses
 */
interface StellarErrorResponse {
  response?: {
    data?: {
      extras?: {
        result_codes?: {
          transaction?: string;
          operations?: string[];
        };
      };
    };
  };
}

/**
 * USDC Asset
 */
export const USDC_ASSET = new Asset(
  process.env.NEXT_PUBLIC_USDC_CODE || "USDC",
  process.env.NEXT_PUBLIC_USDC_ISSUER!,
);

export interface AssetBalance {
  asset_type: "native" | "credit_alphanum4" | "credit_alphanum12" | "liquidity_pool_shares";
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
}

/**
 * Get all balances for a Stellar account
 * @param publicKey Stellar account public key
 * @returns Promise<AssetBalance[]>
 * @throws StellarError
 */
export async function getAccountBalance(
  publicKey: string,
): Promise<AssetBalance[]> {
  try {
    const account = await server.loadAccount(publicKey);

    // Map Horizon response to our interface
    return account.balances.map((b: any) => ({
      asset_type: b.asset_type,
      asset_code: b.asset_code || (b.asset_type === 'native' ? 'XLM' : undefined),
      asset_issuer: b.asset_issuer,
      balance: b.balance,
      limit: b.limit,
      buying_liabilities: b.buying_liabilities,
      selling_liabilities: b.selling_liabilities
    }));
  } catch (error: unknown) {
    console.error("Error fetching account balance:", error);
    // If account doesn't exist yet, return empty balances instead of throwing
    // This allows the UI to handle "new account" state gracefully if needed
    // or we can let the caller handle the 404.
    // For now, let's stick to the existing error handling pattern but maybe refine it.
    throw {
      type: "network_error",
      message: "Failed to fetch Stellar account balance.",
    } as StellarError;
  }
}

/**
 * Validate Stellar public key
 * @param address Stellar address (public key)
 * @returns boolean
 */
export function isValidStellarAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address);
}

/**
 * Send USDC payment from one Stellar account to another
 * @param fromPublicKey Sender public key
 * @param fromSecretKey Sender secret key
 * @param toPublicKey Recipient public key
 * @param amount Amount of USDC to send (string)
 * @returns transaction hash
 * @throws StellarError
 */
export async function sendUSDCPayment(
  fromPublicKey: string,
  fromSecretKey: string,
  toPublicKey: string,
  amount: string,
): Promise<string> {
  if (!isValidStellarAddress(toPublicKey)) {
    throw {
      type: "invalid_address",
      message: "Invalid recipient Stellar address.",
    } as StellarError;
  }

  try {
    const senderKeypair = Keypair.fromSecret(fromSecretKey);
    const account = await server.loadAccount(fromPublicKey);

    const transaction = new TransactionBuilder(account, {
      fee: (await server.fetchBaseFee()).toString(),
      networkPassphrase: STELLAR_NETWORK,
    })
      .addOperation(
        Operation.payment({
          destination: toPublicKey,
          asset: USDC_ASSET,
          amount,
        }),
      )
      .setTimeout(30)
      .build();

    transaction.sign(senderKeypair);

    const txResult = await server.submitTransaction(transaction);

    return txResult.hash;
  } catch (err: unknown) {
    console.error("Error sending USDC payment:", err);

    // Type-safe extraction
    let message = "Failed to send USDC payment.";

    if (err && typeof err === "object") {
      const stellarError = err as StellarErrorResponse;
      const opsMessage =
        stellarError.response?.data?.extras?.result_codes?.operations?.[0];
      if (opsMessage) {
        message = opsMessage;
      }
    }

    throw { type: "payment_failed", message } as StellarError;
  }
}

/**
 * Issue a soulbound token (non-transferable badge) to a recipient
 * This creates a trustline, sends 1 unit of the badge asset, and locks the recipient's trustline
 * @param issuerSecretKey Badge issuer's secret key
 * @param recipientPublicKey Recipient's public key
 * @param badgeAssetCode Asset code for the badge (max 12 chars)
 * @param memo Optional memo for the transaction
 * @returns transaction hash
 * @throws StellarError
 */
export async function issueSoulboundBadge(
  issuerSecretKey: string,
  recipientPublicKey: string,
  badgeAssetCode: string,
  memo?: string,
): Promise<string> {
  if (!isValidStellarAddress(recipientPublicKey)) {
    throw {
      type: "invalid_address",
      message: "Invalid recipient Stellar address.",
    } as StellarError;
  }

  try {
    const issuerKeypair = Keypair.fromSecret(issuerSecretKey);
    const issuerPublicKey = issuerKeypair.publicKey();

    // Create the badge asset
    const badgeAsset = new Asset(badgeAssetCode, issuerPublicKey);

    // Load recipient account
    const recipientAccount = await server.loadAccount(recipientPublicKey);

    // Build transaction to establish trustline and send badge
    const transaction = new TransactionBuilder(recipientAccount, {
      fee: (await server.fetchBaseFee()).toString(),
      networkPassphrase: STELLAR_NETWORK,
    })
      .addOperation(
        Operation.changeTrust({
          asset: badgeAsset,
          limit: "1", // Only allow 1 badge
          source: recipientPublicKey,
        }),
      )
      .setTimeout(30);

    if (memo) {
      transaction.addMemo(Memo.text(memo));
    }

    const builtTx = transaction.build();

    // Sign with issuer (to authorize the trustline)
    builtTx.sign(issuerKeypair);

    // Submit the trustline transaction
    await server.submitTransaction(builtTx);

    // Now send the badge from issuer to recipient
    const issuerAccount = await server.loadAccount(issuerPublicKey);

    const paymentTx = new TransactionBuilder(issuerAccount, {
      fee: (await server.fetchBaseFee()).toString(),
      networkPassphrase: STELLAR_NETWORK,
    })
      .addOperation(
        Operation.payment({
          destination: recipientPublicKey,
          asset: badgeAsset,
          amount: "1",
        }),
      )
      .setTimeout(30);

    if (memo) {
      paymentTx.addMemo(Memo.text(memo));
    }

    const paymentTransaction = paymentTx.build();
    paymentTransaction.sign(issuerKeypair);

    const result = await server.submitTransaction(paymentTransaction);

    return result.hash;
  } catch (err: unknown) {
    console.error("Error issuing soulbound badge:", err);

    let message = "Failed to issue soulbound badge.";

    if (err && typeof err === "object") {
      const stellarError = err as StellarErrorResponse;
      const opsMessage =
        stellarError.response?.data?.extras?.result_codes?.operations?.[0];
      if (opsMessage) {
        message = `${message} Reason: ${opsMessage}`;
      }
    }

    throw { type: "payment_failed", message } as StellarError;
  }
}

/**
 * Configure a Stellar account as a badge issuer with proper flags for soulbound tokens
 * Sets AUTH_REQUIRED, AUTH_REVOCABLE, and AUTH_CLAWBACK_ENABLED flags
 * @param issuerSecretKey Issuer account secret key
 * @returns transaction hash
 * @throws StellarError
 */
export async function configureBadgeIssuer(
  issuerSecretKey: string,
): Promise<string> {
  try {
    const issuerKeypair = Keypair.fromSecret(issuerSecretKey);
    const issuerAccount = await server.loadAccount(issuerKeypair.publicKey());

    const transaction = new TransactionBuilder(issuerAccount, {
      fee: (await server.fetchBaseFee()).toString(),
      networkPassphrase: STELLAR_NETWORK,
    })
      .addOperation(
        Operation.setOptions({
          setFlags: (1 | 2 | 4) as any,
        }),
      )
      .setTimeout(30)
      .build();

    transaction.sign(issuerKeypair);

    const result = await server.submitTransaction(transaction);
    return result.hash;
  } catch (err: unknown) {
    console.error("Error configuring badge issuer:", err);
    throw {
      type: "payment_failed",
      message: "Failed to configure badge issuer account.",
    } as StellarError;
  }
}

/**
 * Check if a user has a specific badge in their wallet
 * @param publicKey User's Stellar public key
 * @param badgeAssetCode Badge asset code
 * @param issuerPublicKey Badge issuer's public key
 * @returns boolean indicating if the badge is in the wallet
 */
export async function hasBadge(
  publicKey: string,
  badgeAssetCode: string,
  issuerPublicKey: string,
): Promise<boolean> {
  try {
    const account = await server.loadAccount(publicKey);

    const badge = account.balances.find(
      (b: any) =>
        b.asset_type !== "native" &&
        b.asset_code === badgeAssetCode &&
        b.asset_issuer === issuerPublicKey &&
        parseFloat(b.balance) > 0,
    );

    return !!badge;
  } catch (error) {
    console.error("Error checking badge ownership:", error);
    return false;
  }
}

/**
 * Add a trustline for an asset
 * @param secretKey User's secret key
 * @param assetCode Asset code
 * @param assetIssuer Asset issuer
 * @returns transaction hash
 */
export async function addTrustline(
  secretKey: string,
  assetCode: string,
  assetIssuer: string
): Promise<string> {
  try {
    const keypair = Keypair.fromSecret(secretKey);
    const account = await server.loadAccount(keypair.publicKey());
    const asset = new Asset(assetCode, assetIssuer);

    const transaction = new TransactionBuilder(account, {
      fee: (await server.fetchBaseFee()).toString(),
      networkPassphrase: STELLAR_NETWORK,
    })
      .addOperation(
        Operation.changeTrust({
          asset,
          source: keypair.publicKey(),
        })
      )
      .setTimeout(30)
      .build();

    transaction.sign(keypair);
    const result = await server.submitTransaction(transaction);
    return result.hash;
  } catch (error) {
    console.error("Error adding trustline:", error);
    throw {
      type: "network_error", // Simplify error type for now
      message: "Failed to add trustline.",
    } as StellarError;
  }
}

/**
 * Remove a trustline for an asset
 * @param secretKey User's secret key
 * @param assetCode Asset code
 * @param assetIssuer Asset issuer
 * @returns transaction hash
 */
export async function removeTrustline(
  secretKey: string,
  assetCode: string,
  assetIssuer: string
): Promise<string> {
  try {
    const keypair = Keypair.fromSecret(secretKey);
    const account = await server.loadAccount(keypair.publicKey());
    const asset = new Asset(assetCode, assetIssuer);

    // To remove a trustline, you set the limit to 0
    const transaction = new TransactionBuilder(account, {
      fee: (await server.fetchBaseFee()).toString(),
      networkPassphrase: STELLAR_NETWORK,
    })
      .addOperation(
        Operation.changeTrust({
          asset,
          limit: "0",
          source: keypair.publicKey(),
        })
      )
      .setTimeout(30)
      .build();

    transaction.sign(keypair);
    const result = await server.submitTransaction(transaction);
    return result.hash;
  } catch (error) {
    console.error("Error removing trustline:", error);
    throw {
      type: "network_error",
      message: "Failed to remove trustline.",
    } as StellarError;
  }
}

