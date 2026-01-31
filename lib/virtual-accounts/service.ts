/**
 * Virtual Account Service
 *
 * Core business logic for virtual account management
 */

import { prisma } from "../db";
import { getVirtualAccountProvider } from "./provider-factory";
import {
  VirtualAccountCreateRequest,
  VirtualAccountDetails,
  AccountExistsError,
} from "./provider-interface";
import { sanitizeAccountName } from "./validation";

export interface VirtualAccountRecord {
  id: string;
  userId: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  provider: string;
  providerRef: string | null;
  status: string;
  createdAt: Date;
}

/**
 * Create a new virtual account for a user
 *
 * @throws AccountExistsError if user already has a virtual account
 * @throws ProviderError if provider API fails
 */
export async function createVirtualAccount(
  userId: string,
): Promise<VirtualAccountRecord> {
  // Check if user already has a virtual account
  const existing = await getVirtualAccountByUserId(userId);
  if (existing) {
    throw new AccountExistsError(existing.provider, existing.accountNumber);
  }

  // Fetch user details
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      name: true,
      phone: true,
    },
  });

  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }

  if (!user.email) {
    throw new Error("User email is required to create virtual account");
  }

  // Parse user name into first and last name
  const nameParts = (user.name || user.email.split("@")[0]).split(" ");
  const firstName = nameParts[0] || "User";
  const lastName = nameParts.slice(1).join(" ") || "LancePay";

  // Create account with provider
  const provider = getVirtualAccountProvider();

  const request: VirtualAccountCreateRequest = {
    userId,
    email: user.email,
    firstName: sanitizeAccountName(firstName),
    lastName: sanitizeAccountName(lastName),
    phoneNumber: user.phone || undefined,
  };

  const accountDetails = await provider.createAccount(request);

  // Save to database
  const virtualAccount = await prisma.virtualAccount.create({
    data: {
      userId,
      bankName: accountDetails.bankName,
      accountNumber: accountDetails.accountNumber,
      accountName: accountDetails.accountName,
      provider: accountDetails.provider,
      providerRef: accountDetails.providerRef,
      status: "active",
    },
  });

  return virtualAccount;
}

/**
 * Get virtual account by user ID
 * Returns null if not found
 */
export async function getVirtualAccountByUserId(
  userId: string,
): Promise<VirtualAccountRecord | null> {
  try {
    const account = await prisma.virtualAccount.findUnique({
      where: { userId },
    });

    return account;
  } catch (error) {
    return null;
  }
}

/**
 * Get virtual account by account number
 * Used for webhook processing to map deposits to users
 */
export async function getVirtualAccountByAccountNumber(
  accountNumber: string,
): Promise<VirtualAccountRecord | null> {
  try {
    const account = await prisma.virtualAccount.findUnique({
      where: { accountNumber },
    });

    return account;
  } catch (error) {
    return null;
  }
}

/**
 * Deactivate a virtual account
 * This doesn't delete from provider, just marks as inactive in our DB
 */
export async function deactivateVirtualAccount(userId: string): Promise<void> {
  await prisma.virtualAccount.update({
    where: { userId },
    data: { status: "inactive" },
  });
}

/**
 * Reactivate a virtual account
 */
export async function reactivateVirtualAccount(userId: string): Promise<void> {
  await prisma.virtualAccount.update({
    where: { userId },
    data: { status: "active" },
  });
}

/**
 * Get all virtual accounts (admin function)
 */
export async function getAllVirtualAccounts(params: {
  skip?: number;
  take?: number;
  provider?: string;
  status?: string;
}): Promise<{
  accounts: VirtualAccountRecord[];
  total: number;
}> {
  const where: Record<string, unknown> = {};

  if (params.provider) {
    where.provider = params.provider;
  }

  if (params.status) {
    where.status = params.status;
  }

  const [accounts, total] = await Promise.all([
    prisma.virtualAccount.findMany({
      where,
      skip: params.skip || 0,
      take: params.take || 50,
      orderBy: { createdAt: "desc" },
    }),
    prisma.virtualAccount.count({ where }),
  ]);

  return { accounts, total };
}

/**
 * Get virtual account statistics
 */
export async function getVirtualAccountStats(): Promise<{
  total: number;
  active: number;
  inactive: number;
  byProvider: Record<string, number>;
}> {
  const [total, active, inactive, byProvider] = await Promise.all([
    prisma.virtualAccount.count(),
    prisma.virtualAccount.count({ where: { status: "active" } }),
    prisma.virtualAccount.count({ where: { status: "inactive" } }),
    prisma.virtualAccount.groupBy({
      by: ["provider"],
      _count: true,
    }),
  ]);

  const providerCounts = byProvider.reduce(
    (acc: any, item: any) => {
      acc[item.provider] = item._count;
      return acc;
    },
    {} as Record<string, number>,
  );

  return {
    total,
    active,
    inactive,
    byProvider: providerCounts,
  };
}
