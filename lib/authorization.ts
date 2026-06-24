/**
 * Authorization utilities for audit log and invoice resource access
 * Provides centralized authorization logic for sensitive resource access
 */

import { prisma } from "@/lib/db";

export const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").split(",").map((email) => email.toLowerCase().trim()).filter(Boolean);

export interface AuditLogAccessContext {
  userId: string;
  userEmail: string;
  isOwner: boolean;
  isCollaborator: boolean;
  isAdmin: boolean;
  canAccess: boolean;
}

/**
 * Check if an email belongs to an admin user
 *
 * @param email - User email to check
 * @returns true if user is an admin
 */
export function isAdminEmail(email: string): boolean {
  const adminEmails = (process.env.ADMIN_EMAILS || "").split(",").map((email) => email.toLowerCase().trim()).filter(Boolean);
  return adminEmails.includes(email.toLowerCase().trim());
}

/**
 * Verify audit log access for a user
 *
 * Checks if user is:
 * 1. Invoice owner (can access full logs)
 * 2. Invoice collaborator (can access with masked sensitive data)
 * 3. System admin (can access all logs)
 *
 * @param invoiceId - Invoice ID to check access for
 * @param userId - User ID to verify
 * @param userEmail - User email for admin check
 * @returns Access context with permission flags
 * @throws Error if invoice or user lookup fails
 */
export async function checkAuditLogAccess(
  invoiceId: string,
  userId: string,
  userEmail: string,
): Promise<AuditLogAccessContext> {
  // Short-circuit admin check
  if (isAdminEmail(userEmail)) {
    return {
      userId,
      userEmail,
      isOwner: false,
      isCollaborator: false,
      isAdmin: true,
      canAccess: true,
    };
  }

  // Fetch invoice with minimal data
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      userId: true,
    },
  });

  // Return deny for non-existent invoice (prevent information leakage)
  if (!invoice) {
    return {
      userId,
      userEmail,
      isOwner: false,
      isCollaborator: false,
      isAdmin: false,
      canAccess: false,
    };
  }

  // Check owner status
  const isOwner = invoice.userId === userId;
  if (isOwner) {
    return {
      userId,
      userEmail,
      isOwner: true,
      isCollaborator: false,
      isAdmin: false,
      canAccess: true,
    };
  }

  // Check collaborator status
  const collaboration = await prisma.invoiceCollaborator.findFirst({
    where: {
      invoiceId,
      subContractorId: userId,
    },
    select: {
      id: true,
    },
  });

  const isCollaborator = !!collaboration;

  return {
    userId,
    userEmail,
    isOwner: false,
    isCollaborator,
    isAdmin: false,
    canAccess: isCollaborator,
  };
}
