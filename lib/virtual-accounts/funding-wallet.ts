/**
 * Funding Wallet Helper
 *
 * Manages platform's funding wallet for crediting users with USDC
 * after NGN deposits to virtual accounts
 */

import { Keypair } from "@stellar/stellar-sdk";
import { getAccountBalance } from "../stellar";

/**
 * Get funding wallet keypair from environment
 */
export function getFundingWallet(): {
  publicKey: string;
  secretKey: string;
  keypair: Keypair;
} {
  const secretKey = process.env.STELLAR_FUNDING_WALLET_SECRET;

  if (!secretKey) {
    throw new Error(
      "STELLAR_FUNDING_WALLET_SECRET not configured. " +
        "This wallet is required to credit users with USDC after virtual account deposits.",
    );
  }

  try {
    const keypair = Keypair.fromSecret(secretKey);
    return {
      publicKey: keypair.publicKey(),
      secretKey,
      keypair,
    };
  } catch (error) {
    throw new Error(
      `Invalid STELLAR_FUNDING_WALLET_SECRET: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Check funding wallet USDC balance
 * Returns balance in USDC (as number)
 */
export async function checkFundingWalletBalance(): Promise<number> {
  try {
    const { publicKey } = getFundingWallet();
    const balances = await getAccountBalance(publicKey);

    // Find USDC balance
    const usdcIssuer = process.env.NEXT_PUBLIC_USDC_ISSUER;
    if (!usdcIssuer) {
      throw new Error("NEXT_PUBLIC_USDC_ISSUER not configured");
    }

    // const usdcBalance = balances.find(
    //   (b) => b.asset_code === "USDC" && b.asset_issuer === usdcIssuer,
    // );
    const usdcBalance = balances.usdc;

    if (!usdcBalance) {
      return 0;
    }

    return parseFloat(usdcBalance);
  } catch (error) {
    throw new Error(
      `Failed to check funding wallet balance: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Validate funding wallet has sufficient USDC
 * Throws error if balance is below minimum threshold
 */
export async function ensureSufficientBalance(
  requiredAmount: number,
  minimumReserve: number = 1000, // Keep at least $1000 USDC in funding wallet
): Promise<void> {
  const currentBalance = await checkFundingWalletBalance();

  if (currentBalance < requiredAmount + minimumReserve) {
    throw new Error(
      `Insufficient USDC in funding wallet. ` +
        `Current: $${currentBalance}, Required: $${requiredAmount + minimumReserve} ` +
        `(includes $${minimumReserve} reserve)`,
    );
  }
}

/**
 * Alert configuration for low balance
 */
export interface BalanceAlertConfig {
  warningThreshold: number; // Alert when balance falls below this
  criticalThreshold: number; // Critical alert
  alertEmail?: string;
}

/**
 * Check if funding wallet balance is low and should trigger alert
 */
export async function checkBalanceAlert(config: BalanceAlertConfig): Promise<{
  shouldAlert: boolean;
  level: "none" | "warning" | "critical";
  currentBalance: number;
  message?: string;
}> {
  try {
    const currentBalance = await checkFundingWalletBalance();

    if (currentBalance <= config.criticalThreshold) {
      return {
        shouldAlert: true,
        level: "critical",
        currentBalance,
        message: `CRITICAL: Funding wallet balance at $${currentBalance} (threshold: $${config.criticalThreshold})`,
      };
    }

    if (currentBalance <= config.warningThreshold) {
      return {
        shouldAlert: true,
        level: "warning",
        currentBalance,
        message: `WARNING: Funding wallet balance at $${currentBalance} (threshold: $${config.warningThreshold})`,
      };
    }

    return {
      shouldAlert: false,
      level: "none",
      currentBalance,
    };
  } catch (error) {
    return {
      shouldAlert: true,
      level: "critical",
      currentBalance: 0,
      message: `ERROR: Failed to check funding wallet balance: ${error instanceof Error ? error.message : "Unknown"}`,
    };
  }
}

/**
 * Send alert email for low balance
 * This should be called by a cron job or monitoring service
 */
export async function sendBalanceAlert(alertMessage: string): Promise<void> {
  const alertEmail = process.env.ADMIN_ALERT_EMAIL;

  if (!alertEmail) {
    console.error(
      "ADMIN_ALERT_EMAIL not configured, cannot send balance alert",
    );
    return;
  }

  // TODO: Integrate with your email service
  console.error("🚨 FUNDING WALLET ALERT:", alertMessage);
  console.error(`Alert should be sent to: ${alertEmail}`);

  // Example integration with Resend (if you're using it)
  // import { sendEmail } from '../email'
  // await sendEmail({
  //   to: alertEmail,
  //   subject: '🚨 LancePay Funding Wallet Low Balance Alert',
  //   html: `<p>${alertMessage}</p>`,
  // })
}
