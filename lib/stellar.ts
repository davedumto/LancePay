import { Horizon, Networks, Asset, Keypair, TransactionBuilder, Operation, StrKey, Transaction } from "@stellar/stellar-sdk";

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
 */
export const USDC_ASSET = new Asset(
  process.env.NEXT_PUBLIC_USDC_CODE || "USDC",
  process.env.NEXT_PUBLIC_USDC_ISSUER!,
);

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
 * Get balances of XLM and USDC for a Stellar account
 * @param publicKey Stellar account public key
 * @returns Promise<AccountBalance>
 * @throws StellarError
 */
export async function getAccountBalance(
  publicKey: string,
): Promise<AccountBalance> {
  try {
    const account: StellarSdk.AccountResponse =
      await server.loadAccount(publicKey);

    const xlmBalance: string =
      account.balances.find(
        (b: StellarSdk.Balance) => b.asset_type === "native",
      )?.balance || "0";
    const account = await server.loadAccount(publicKey);

    const xlmBalance: string =
      account.balances.find((b: any) => b.asset_type === "native")
        ?.balance || "0";

    const usdcBalance: string =
      account.balances.find(
        (b: any) =>
          b.asset_type !== "native" &&
          b.asset_code === USDC_ASSET.code &&
          b.asset_issuer === USDC_ASSET.issuer,
      )?.balance || "0";

    return { xlm: xlmBalance, usdc: usdcBalance };
  } catch (error: unknown) {
    console.error("Error fetching account balance:", error);
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
    const senderKeypair: StellarSdk.Keypair =
      StellarSdk.Keypair.fromSecret(fromSecretKey);
    const account: StellarSdk.AccountResponse =
      await server.loadAccount(fromPublicKey);

    const transaction: StellarSdk.Transaction =
      new StellarSdk.TransactionBuilder(account, {
        fee: await server.fetchBaseFee(),
        networkPassphrase: STELLAR_NETWORK,
      })
        .addOperation(
          StellarSdk.Operation.payment({
            destination: toPublicKey,
            asset: USDC_ASSET,
            amount,
          }),
        )
        .setTimeout(30)
        .build();

    transaction.sign(senderKeypair);

    const txResult: StellarSdk.SubmitTransactionResponse =
      await server.submitTransaction(transaction);
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
