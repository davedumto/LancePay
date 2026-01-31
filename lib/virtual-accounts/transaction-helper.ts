/**
 * Transaction Helper
 *
 * Handles transaction recording for virtual account deposits
 */

import { prisma } from "../db";
import { Decimal } from "@prisma/client/runtime/library";

export interface CreateDepositTransactionParams {
  userId: string;
  virtualAccountId: string;
  ngnAmount: number;
  usdcAmount: number;
  exchangeRate: number;
  providerReference: string; // External reference from provider
  txHash?: string; // Stellar transaction hash (added after USDC transfer)
  senderName?: string;
  narration?: string;
}

/**
 * Create a deposit transaction record
 */
export async function createDepositTransaction(
  params: CreateDepositTransactionParams,
): Promise<{ id: string; externalId: string }> {
  try {
    const transaction = await prisma.transaction.create({
      data: {
        userId: params.userId,
        virtualAccountId: params.virtualAccountId,
        type: "deposit", // Virtual account deposit
        status: "pending", // Will be updated to 'completed' after USDC transfer
        amount: new Decimal(params.usdcAmount),
        currency: "USD",
        ngnAmount: new Decimal(params.ngnAmount),
        exchangeRate: new Decimal(params.exchangeRate),
        externalId: params.providerReference, // Provider's unique reference
        txHash: params.txHash || null,
        createdAt: new Date(),
      },
    });

    return {
      id: transaction.id,
      externalId: transaction.externalId!,
    };
  } catch (error) {
    throw new Error(
      `Failed to create deposit transaction: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Check if a deposit has already been processed (idempotency check)
 * Returns the existing transaction if found
 */
export async function findExistingDeposit(
  providerReference: string,
): Promise<{ id: string; status: string; userId: string } | null> {
  try {
    const transaction = await prisma.transaction.findUnique({
      where: {
        externalId: providerReference,
      },
      select: {
        id: true,
        status: true,
        userId: true,
      },
    });

    return transaction;
  } catch (error) {
    throw new Error(
      `Failed to check existing deposit: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Update transaction with Stellar tx hash and mark as completed
 */
export async function completeDepositTransaction(
  transactionId: string,
  txHash: string,
): Promise<void> {
  try {
    await prisma.transaction.update({
      where: { id: transactionId },
      data: {
        txHash,
        status: "completed",
        completedAt: new Date(),
      },
    });
  } catch (error) {
    throw new Error(
      `Failed to complete transaction: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Mark transaction as failed
 */
export async function failDepositTransaction(
  transactionId: string,
  errorMessage: string,
): Promise<void> {
  try {
    await prisma.transaction.update({
      where: { id: transactionId },
      data: {
        status: "failed",
        error: errorMessage,
        completedAt: new Date(),
      },
    });
  } catch (error) {
    throw new Error(
      `Failed to mark transaction as failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Get deposit statistics for a user
 */
export async function getUserDepositStats(userId: string): Promise<{
  totalDeposits: number;
  totalNGN: number;
  totalUSDC: number;
  count: number;
}> {
  try {
    const deposits = await prisma.transaction.findMany({
      where: {
        userId,
        type: "deposit",
        status: "completed",
      },
      select: {
        amount: true,
        ngnAmount: true,
      },
    });

    const stats = deposits.reduce(
      (acc: any, deposit: any) => ({
        totalUSDC: acc.totalUSDC + Number(deposit.amount),
        totalNGN: acc.totalNGN + Number(deposit.ngnAmount || 0),
        count: acc.count + 1,
      }),
      { totalUSDC: 0, totalNGN: 0, count: 0 },
    );

    return {
      ...stats,
      totalDeposits: stats.count,
    };
  } catch (error) {
    throw new Error(
      `Failed to get deposit stats: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}
