import {
  Horizon,
  Asset,
  Keypair,
  TransactionBuilder,
  Operation,
  StrKey,
  Transaction,
  Memo,
  AuthFlag as StellarAuthFlag,
  BASE_FEE,
} from "@stellar/stellar-sdk";

import { STELLAR_NETWORK_CONFIG } from "@/lib/stellar-network";

/**
 * Stellar Network Configuration
 * Resolved once by lib/stellar-network.ts — the single source of truth shared
 * with lib/stellar-funding.ts. Throws at module load on unsafe mainnet config.
 */
export const STELLAR_NETWORK: string = STELLAR_NETWORK_CONFIG.networkPassphrase;

export const HORIZON_URL: string = STELLAR_NETWORK_CONFIG.horizonUrl;

export const server = new Horizon.Server(HORIZON_URL);

/**
 * USDC Asset issuer, resolved by lib/stellar-network.ts. On testnet it falls
 * back to the well-known testnet issuer; on mainnet the env var is required.
 */
const USDC_ISSUER = STELLAR_NETWORK_CONFIG.usdcIssuer;

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
  | { type: "payment_failed"; message: string }
  | { type: "insufficient_funds"; message: string };

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
  STELLAR_NETWORK_CONFIG.usdcCode,
  USDC_ISSUER,
);

export interface AssetBalance {
  asset_type:
  | "native"
  | "credit_alphanum4"
  | "credit_alphanum12"
  | "liquidity_pool_shares";
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
      asset_code:
        b.asset_code || (b.asset_type === "native" ? "XLM" : undefined),
      asset_issuer: b.asset_issuer,
      balance: b.balance,
      limit: b.limit,
      buying_liabilities: b.buying_liabilities,
      selling_liabilities: b.selling_liabilities,
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

const STELLAR_TEXT_MEMO_MAX_BYTES = 28;

function sanitizeStellarTextMemo(memo?: string): string | null {
  if (!memo) return null;
  let trimmed = memo.trim();
  if (!trimmed) return null;

  while (Buffer.byteLength(trimmed, "utf8") > STELLAR_TEXT_MEMO_MAX_BYTES) {
    trimmed = trimmed.slice(0, -1);
  }

  return trimmed || null;
}

/**
 * Send USDC payment from one Stellar account to another
 * @param fromPublicKey Sender public key
 * @param fromSecretKey Sender secret key
 * @param toPublicKey Recipient public key
 * @param amount Amount of USDC to send (string)
 * @param memo Optional transaction memo (truncated to 28 bytes)
 * @returns transaction hash
 * @throws StellarError
 */
export async function sendUSDCPayment(
  fromPublicKey: string,
  fromSecretKey: string,
  toPublicKey: string,
  amount: string,
  memo?: string,
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

    const builder = new TransactionBuilder(account, {
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
      .setTimeout(30);

    const safeMemo = sanitizeStellarTextMemo(memo);
    if (safeMemo) {
      builder.addMemo(Memo.text(safeMemo));
    }

    const transaction = builder.build();

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
 * Debit USDC from a user's self-custody wallet using the platform's
 * delegated signer, and forward it to the platform's treasury account.
 *
 * This is used for withdrawals: LancePay never holds the user's own secret
 * key, so the delegated signer must be registered as an additional signer
 * with sufficient weight on the user's Stellar account (set up during wallet
 * provisioning) in order to co-sign payments out of it. The transaction's
 * source account is the user's wallet, so Horizon enforces the real on-chain
 * balance when the transaction is submitted: an underfunded account fails
 * the submission outright (op_underfunded). That is what makes this debit
 * atomic with the balance check - two concurrent debits against the same
 * balance cannot both succeed, because Horizon only lets one of them post
 * before the account is underfunded for the other.
 *
 * @param delegateSecretKey Platform delegated signer's secret key
 * @param fromPublicKey User's wallet public key (transaction source)
 * @param toPublicKey Treasury/receiver public key
 * @param amount Amount of USDC to debit (string)
 * @param memo Optional transaction memo (truncated to 28 bytes)
 * @returns transaction hash
 * @throws StellarError with type "insufficient_funds" on an underfunded account
 */
export async function debitDelegatedUSDC(
  delegateSecretKey: string,
  fromPublicKey: string,
  toPublicKey: string,
  amount: string,
  memo?: string,
): Promise<string> {
  if (!isValidStellarAddress(fromPublicKey) || !isValidStellarAddress(toPublicKey)) {
    throw {
      type: "invalid_address",
      message: "Invalid Stellar address.",
    } as StellarError;
  }

  try {
    const delegateKeypair = Keypair.fromSecret(delegateSecretKey);
    const account = await server.loadAccount(fromPublicKey);

    const builder = new TransactionBuilder(account, {
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
      .setTimeout(30);

    const safeMemo = sanitizeStellarTextMemo(memo);
    if (safeMemo) {
      builder.addMemo(Memo.text(safeMemo));
    }

    const transaction = builder.build();

    // Signed by the delegated signer, not the user - see doc comment above.
    transaction.sign(delegateKeypair);

    const txResult = await server.submitTransaction(transaction);
    return txResult.hash;
  } catch (err: unknown) {
    console.error("Error debiting delegated USDC withdrawal:", err);

    const stellarError = err as StellarErrorResponse;
    const opsMessage =
      stellarError?.response?.data?.extras?.result_codes?.operations?.[0];

    if (opsMessage === "op_underfunded") {
      throw {
        type: "insufficient_funds",
        message: "Wallet does not have enough USDC to cover this withdrawal.",
      } as StellarError;
    }

    throw {
      type: "payment_failed",
      message: opsMessage || "Failed to debit withdrawal from Stellar wallet.",
    } as StellarError;
  }
}

/**
 * Prepare an unsigned trustline transaction XDR for the recipient to sign.
 *
 * In the non-custodial badge issuance flow this is Step 1: the recipient must
 * create a trustline for the badge asset (limit = 1) by signing this transaction
 * client-side (e.g. via WalletConnect) and submitting it to Stellar themselves.
 * The server never touches the recipient's secret key.
 *
 * @param recipientPublicKey Recipient's public key
 * @param issuerPublicKey Badge issuer's public key
 * @param badgeAssetCode Asset code for the badge (max 12 chars)
 * @param memo Optional memo (truncated to 28 bytes)
 * @returns Unsigned transaction XDR string
 */
export async function prepareBadgeTrustlineXdr(
  recipientPublicKey: string,
  issuerPublicKey: string,
  badgeAssetCode: string,
  memo?: string,
): Promise<string> {
  const badgeAsset = new Asset(badgeAssetCode, issuerPublicKey);
  const baseFee = (await server.fetchBaseFee()).toString();
  const safeMemo = sanitizeStellarTextMemo(memo);

  const recipientAccount = await server.loadAccount(recipientPublicKey);
  const txBuilder = new TransactionBuilder(recipientAccount, {
    fee: baseFee,
    networkPassphrase: STELLAR_NETWORK,
  })
    .addOperation(
      Operation.changeTrust({
        asset: badgeAsset,
        limit: "1",
      }),
    )
    .setTimeout(30);

  if (safeMemo) {
    txBuilder.addMemo(Memo.text(safeMemo));
  }

  return txBuilder.build().toXDR();
}

/**
 * Issue a soulbound token (non-transferable badge) to a recipient.
 *
 * Soulbound enforcement mechanism:
 * - The issuer account must have AUTH_REQUIRED, AUTH_REVOCABLE, and AUTH_CLAWBACK_ENABLED
 *   flags set (via configureBadgeIssuer) before calling this function.
 * - The recipient first creates a trustline for the badge asset (limit = 1).
 * - The issuer then calls setTrustLineFlags to AUTHORIZE the recipient's trustline —
 *   this is the gating step that enforces soulbound semantics: only the issuer can
 *   authorize new trustlines, so the badge cannot be transferred to a third party
 *   (any receiving account would need a new issuer-authorized trustline).
 * - Finally, the issuer sends 1 unit of the badge asset to the recipient.
 *
 * @param issuerSecretKey Badge issuer's secret key
 * @param recipientPublicKey Recipient's public key
 * @param badgeAssetCode Asset code for the badge (max 12 chars)
 * @param memo Optional memo for the transaction (truncated to 28 bytes)
 * @returns transaction hash of the payment (final) transaction
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
    const badgeAsset = new Asset(badgeAssetCode, issuerPublicKey);
    const baseFee = (await server.fetchBaseFee()).toString();
    const safeMemo = sanitizeStellarTextMemo(memo);

    // Step 1 (trustline creation) is performed client-side: the caller must use
    // prepareBadgeTrustlineXdr(), have the recipient sign the returned XDR via
    // WalletConnect, and submit it to Stellar before calling this function.

    // Step 2: Issuer authorizes the recipient's trustline using setTrustLineFlags.
    // AUTHORIZED_FLAG = 1  →  allows the trustline to hold the asset.
    // This is the soulbound gate: without issuer authorization no third party
    // can receive this asset, enforcing non-transferability at the protocol level.
    const issuerAccountForAuth = await server.loadAccount(issuerPublicKey);
    const authTx = new TransactionBuilder(issuerAccountForAuth, {
      fee: baseFee,
      networkPassphrase: STELLAR_NETWORK,
    })
      .addOperation(
        Operation.setTrustLineFlags({
          trustor: recipientPublicKey,
          asset: badgeAsset,
          flags: {
            authorized: true,
            authorizedToMaintainLiabilities: false,
          },
        }),
      )
      .setTimeout(30)
      .build();

    authTx.sign(issuerKeypair);
    await server.submitTransaction(authTx);

    // Step 3: Issuer sends 1 unit of the badge asset to the recipient.
    const issuerAccountForPayment = await server.loadAccount(issuerPublicKey);
    const paymentTxBuilder = new TransactionBuilder(issuerAccountForPayment, {
      fee: baseFee,
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

    if (safeMemo) {
      paymentTxBuilder.addMemo(Memo.text(safeMemo));
    }

    const paymentTx = paymentTxBuilder.build();
    paymentTx.sign(issuerKeypair);
    const result = await server.submitTransaction(paymentTx);

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
 * Query all soulbound badges held by a Stellar wallet address.
 * Returns badge assets in a format compatible with external Stellar wallets
 * (Lobstr, Solar, etc.) that display custom assets from the account's balances.
 *
 * @param walletAddress Stellar public key to query
 * @param issuerPublicKey Badge issuer public key (to filter only LancePay badges)
 * @returns Array of badge asset entries visible to external wallets
 */
export async function getWalletBadges(
  walletAddress: string,
  issuerPublicKey: string,
): Promise<
  {
    assetCode: string;
    issuer: string;
    balance: string;
    limit: string;
    authorized: boolean;
  }[]
> {
  if (!isValidStellarAddress(walletAddress)) {
    throw {
      type: "invalid_address",
      message: "Invalid wallet Stellar address.",
    } as StellarError;
  }

  try {
    const account = await server.loadAccount(walletAddress);

    return account.balances
      .filter(
        (b: any) =>
          b.asset_type !== "native" &&
          b.asset_issuer === issuerPublicKey &&
          parseFloat(b.balance) > 0,
      )
      .map((b: any) => ({
        assetCode: b.asset_code,
        issuer: b.asset_issuer,
        balance: b.balance,
        limit: b.limit,
        // is_authorized reflects whether the issuer has granted the trustline —
        // for soulbound badges this will always be true for legitimately issued badges.
        authorized: b.is_authorized === true,
      }));
  } catch (error) {
    console.error("Error fetching wallet badges:", error);
    throw {
      type: "network_error",
      message: "Failed to fetch wallet badges.",
    } as StellarError;
  }
}

/**
 * Configure a Stellar account as a badge issuer with the flags required for soulbound tokens.
 *
 * Required flags (Stellar AuthFlag):
 *  - AUTH_REQUIRED      : Trustlines to this issuer start unauthorized; issuer must
 *                         explicitly call setTrustLineFlags to allow each recipient.
 *                         This is the key soulbound enforcement: a badge cannot be
 *                         transferred to a new wallet because any new trustline would
 *                         start unauthorized and the issuer would never approve it.
 *  - AUTH_REVOCABLE     : Issuer can deauthorize (revoke) a trustline at any time,
 *                         enabling badge revocation if needed (e.g., misconduct).
 *  - AUTH_CLAWBACK_ENABLED: Issuer can clawback the asset from any holder, providing
 *                         a last-resort recovery mechanism.
 *
 * This function must be called once when setting up the badge issuer account,
 * before any badges are issued.
 *
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
          setFlags: (1 | 2 | 8) as any,
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
  assetIssuer: string,
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
        }),
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
  assetIssuer: string,
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
        }),
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

export interface StellarTransaction {
  transaction_hash: string;
  type: string;
  created_at: string;
  transaction_successful: boolean;
  from: string;
  to: string;
  amount?: string;
  asset_code?: string;
  asset_type?: string;
  memo?: string;
}

/**
 * Fetch full transaction history for a potentially large account using cursor-based pagination.
 * @param publicKey Stellar account public key
 * @param startDate Optional start date filter
 * @param endDate Optional end date filter
 * @returns List of formatted transactions
 */
export async function fetchFullTransactionHistory(
  publicKey: string,
  startDate?: Date,
  endDate?: Date,
): Promise<StellarTransaction[]> {
  try {
    const allRecords: any[] = [];
    let response = await server
      .payments()
      .forAccount(publicKey)
      .order("desc")
      .limit(100)
      .call();

    while (response.records.length > 0) {
      // Check if we've reached a record older than startDate
      if (startDate) {
        const oldestRecordDate = new Date(
          response.records[response.records.length - 1].created_at,
        );
        if (oldestRecordDate < startDate) {
          // Some records in current page might still be valid, filter below
          allRecords.push(...response.records);
          break;
        }
      }

      allRecords.push(...response.records);

      // Get next page
      response = await response.next();
    }

    const formatted = allRecords.map(
      (r: any) =>
        ({
          transaction_hash: r.transaction_hash,
          type: r.type,
          created_at: r.created_at,
          transaction_successful: r.transaction_successful,
          from: r.from,
          to: r.to,
          amount: r.amount,
          asset_code: r.asset_code,
          asset_type: r.asset_type,
        }) as StellarTransaction,
    );

    // Filter by date if provided
    return formatted.filter((t) => {
      const date = new Date(t.created_at);
      if (startDate && date < startDate) return false;
      if (endDate && date > endDate) return false;
      return true;
    });
  } catch (error) {
    console.error("Error fetching Stellar transaction history:", error);
    return [];
  }
}

/**
 * Async generator to stream transaction history for memory-efficient processing.
 * @param publicKey Stellar account public key
 * @param startDate Optional start date filter
 * @param endDate Optional end date filter
 */
export async function* streamFullTransactionHistory(
  publicKey: string,
  startDate?: Date,
  endDate?: Date,
): AsyncGenerator<StellarTransaction> {
  try {
    let response = await server
      .payments()
      .forAccount(publicKey)
      .order("desc")
      .limit(100)
      .call();

    while (response.records.length > 0) {
      for (const r of response.records as any[]) {
        const date = new Date(r.created_at);

        // If we've passed the end date, skip (since we are desc, they will be later)
        if (endDate && date > endDate) continue;

        // If we've reached before start date, we are done
        if (startDate && date < startDate) return;

        yield {
          transaction_hash: r.transaction_hash,
          type: r.type,
          created_at: r.created_at,
          transaction_successful: r.transaction_successful,
          from: r.from,
          to: r.to,
          amount: r.amount,
          asset_code: r.asset_code,
          asset_type: r.asset_type,
        } as StellarTransaction;
      }

      response = await response.next();
    }
  } catch (error) {
    console.error("Error streaming Stellar transaction history:", error);
  }
}

/**
 * Interface for path payment quote
 */
export interface PathPaymentQuote {
  sourceAsset: Asset;
  sourceAmount: string;
  destinationAsset: Asset;
  destinationAmount: string;
  path: Asset[];
}

/**
 * Calculate the required send amount for a strict-receive path payment
 * Queries Horizon's strict_receive_paths endpoint to find the best conversion path
 * @param sourceAsset The asset to send (e.g., XLM, EURT)
 * @param destinationAsset The asset to receive (e.g., USDC)
 * @param destinationAmount The exact amount to receive
 * @param sourcePublicKey Source account public key
 * @returns Promise<PathPaymentQuote> Quote with required send amount and path
 * @throws StellarError
 */
export async function calculateStrictReceivePath(
  sourceAsset: Asset,
  destinationAsset: Asset,
  destinationAmount: string,
  sourcePublicKey: string,
): Promise<PathPaymentQuote> {
  try {
    // Query Horizon for strict receive paths using source account
    const pathsCallBuilder = server
      .strictReceivePaths(sourcePublicKey, destinationAsset, destinationAmount)
      .limit(1);

    const pathsResponse = await pathsCallBuilder.call();

    if (pathsResponse.records.length === 0) {
      throw {
        type: "payment_failed",
        message:
          "No path found for this asset pair. The destination asset may not have sufficient liquidity on the DEX.",
      } as StellarError;
    }

    const bestPath = pathsResponse.records[0];

    return {
      sourceAsset,
      sourceAmount: bestPath.source_amount,
      destinationAsset,
      destinationAmount,
      path: bestPath.path.map((p: any) =>
        p.asset_type === "native"
          ? Asset.native()
          : new Asset(p.asset_code, p.asset_issuer),
      ),
    };
  } catch (error: unknown) {
    console.error("Error calculating strict receive path:", error);

    if (error && typeof error === "object" && "type" in error) {
      throw error;
    }

    throw {
      type: "network_error",
      message: "Failed to calculate path payment route.",
    } as StellarError;
  }
}

/**
 * Send a path payment with strict receive
 * Allows paying with one asset (e.g., XLM, EURT) while recipient receives exact amount in another asset (e.g., USDC)
 * @param fromSecretKey Sender's secret key
 * @param toPublicKey Recipient's public key
 * @param sendAsset Asset to send
 * @param sendMax Maximum amount willing to send
 * @param destAsset Asset recipient will receive
 * @param destAmount Exact amount recipient will receive
 * @param path Optional array of assets to use as conversion path
 * @returns transaction hash
 * @throws StellarError
 */
export async function sendPathPayment(
  fromSecretKey: string,
  toPublicKey: string,
  sendAsset: Asset,
  sendMax: string,
  destAsset: Asset,
  destAmount: string,
  path?: Asset[],
): Promise<string> {
  if (!isValidStellarAddress(toPublicKey)) {
    throw {
      type: "invalid_address",
      message: "Invalid recipient Stellar address.",
    } as StellarError;
  }

  try {
    const senderKeypair = Keypair.fromSecret(fromSecretKey);
    const account = await server.loadAccount(senderKeypair.publicKey());

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: STELLAR_NETWORK,
    })
      .addOperation(
        Operation.pathPaymentStrictReceive({
          sendAsset,
          sendMax,
          destination: toPublicKey,
          destAsset,
          destAmount,
          path: path || [],
        }),
      )
      .setTimeout(30)
      .build();

    transaction.sign(senderKeypair);

    const txResult = await server.submitTransaction(transaction);

    return txResult.hash;
  } catch (err: unknown) {
    console.error("Error sending path payment:", err);

    let message = "Failed to send path payment.";

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

export const sendStellarPayment = sendUSDCPayment;

/**
 * Result codes extracted from a Horizon submission error, following the same
 * shape used in lib/stellar-funding.ts.
 */
function extractResultCodes(e: unknown): {
  tx?: string;
  ops?: string[];
  status?: number;
} {
  const err = e as StellarErrorResponse & {
    response?: { status?: number };
  };
  return {
    status: err?.response?.status,
    tx: err?.response?.data?.extras?.result_codes?.transaction,
    ops: err?.response?.data?.extras?.result_codes?.operations,
  };
}

/**
 * Whether a Horizon submission error is a sequence-number collision that is
 * safe to retry against a freshly loaded account sequence.
 */
function isSequenceCollisionError(e: unknown): boolean {
  return extractResultCodes(e).tx === "tx_bad_seq";
}

export const MULTISIG_BROADCAST_MAX_SEQUENCE_RETRIES = 3;

/**
 * Submit an already-approved multisig USDC payment, retrying with a freshly
 * loaded account sequence when Horizon reports a sequence-number collision
 * (tx_bad_seq) - e.g. another transaction from the same source account
 * landed between building and submitting this one.
 *
 * Retries are capped at MULTISIG_BROADCAST_MAX_SEQUENCE_RETRIES so sustained
 * contention fails loudly instead of looping forever.
 *
 * @throws StellarError on invalid destination or after retries are exhausted
 */
export async function submitMultisigPaymentWithRetry(
  sourceSecretKey: string,
  destinationAddress: string,
  amount: string,
  memo?: string,
  maxRetries: number = MULTISIG_BROADCAST_MAX_SEQUENCE_RETRIES,
): Promise<string> {
  if (!isValidStellarAddress(destinationAddress)) {
    throw {
      type: "invalid_address",
      message: "Invalid destination Stellar address.",
    } as StellarError;
  }

  const sourceKeypair = Keypair.fromSecret(sourceSecretKey);
  const safeMemo = sanitizeStellarTextMemo(memo);

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Reload the account on every attempt so a retry always builds against
      // the current on-chain sequence number rather than a stale one.
      const account = await server.loadAccount(sourceKeypair.publicKey());

      const builder = new TransactionBuilder(account, {
        fee: (await server.fetchBaseFee()).toString(),
        networkPassphrase: STELLAR_NETWORK,
      })
        .addOperation(
          Operation.payment({
            destination: destinationAddress,
            asset: USDC_ASSET,
            amount,
          }),
        )
        .setTimeout(30);

      if (safeMemo) {
        builder.addMemo(Memo.text(safeMemo));
      }

      const transaction = builder.build();
      transaction.sign(sourceKeypair);

      const txResult = await server.submitTransaction(transaction);
      return txResult.hash;
    } catch (err: unknown) {
      lastError = err;

      if (attempt < maxRetries && isSequenceCollisionError(err)) {
        console.warn("Multisig broadcast sequence collision, retrying", {
          attempt,
          maxRetries,
        });
        continue;
      }

      break;
    }
  }

  console.error("Error broadcasting multisig payment:", lastError);

  let message = "Failed to broadcast multisig payment.";
  if (lastError && typeof lastError === "object") {
    const opsMessage = extractResultCodes(lastError).ops?.[0];
    if (opsMessage) {
      message = opsMessage;
    } else if (isSequenceCollisionError(lastError)) {
      message =
        "Sequence-number collision persisted after retrying; try broadcasting again.";
    }
  }

  throw { type: "payment_failed", message } as StellarError;
}
