/**
 * Authorization utilities for audit log and invoice resource access
 * Provides centralized authorization logic for sensitive resource access
 */

import { prisma } from "@/lib/db";

function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.toLowerCase().trim())
    .filter(Boolean);
}

export const ADMIN_EMAILS = adminEmails();

/**
 * Roles that grant admin privileges. The User.role column is the primary,
 * revocable source of truth for admin identity; ADMIN_EMAILS remains as a
 * break-glass bootstrap list for accounts that have not been provisioned a
 * role yet.
 */
export const ADMIN_ROLES = new Set(["admin", "superadmin", "super_admin"]);

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
  return adminEmails().includes(email.toLowerCase().trim());
}

/**
 * Single source of truth for admin identity.
 *
 * A user is an admin when their `User.role` is an admin role
 * ({@link ADMIN_ROLES}) OR their email appears in the ADMIN_EMAILS
 * break-glass list. Prefer passing the full user record; `email`/`role`
 * are both optional so partial selects still work.
 *
 * @param user - Object with optional `role` and `email` fields
 * @returns true if the user should be treated as an admin
 */
export function isAdmin(user: { role?: string | null; email?: string | null }): boolean {
  if (user.role && ADMIN_ROLES.has(user.role)) return true;
  if (user.email && isAdminEmail(user.email)) return true;
  return false;
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
  userRole?: string | null,
): Promise<AuditLogAccessContext> {
  // Short-circuit admin check
  if (isAdmin({ email: userEmail, role: userRole })) {
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
