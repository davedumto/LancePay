import { createHmac } from "crypto";
import { prisma } from "@/lib/db";

const AUDIT_SECRET =
  process.env.AUDIT_SECRET || "default-audit-secret-change-in-production";

interface AuditMetadata {
  ip?: string;
  userAgent?: string;
  [key: string]: unknown;
}

export function generateSignature(
  invoiceId: string,
  eventType: string,
  timestamp: string,
  metadata: AuditMetadata | null,
): string {
  const payload = `${invoiceId}:${eventType}:${timestamp}:${JSON.stringify(metadata || {})}`;
  return createHmac("sha256", AUDIT_SECRET).update(payload).digest("hex");
}

export function verifySignature(
  invoiceId: string,
  eventType: string,
  timestamp: string,
  metadata: AuditMetadata | null,
  signature: string,
): boolean {
  const expected = generateSignature(invoiceId, eventType, timestamp, metadata);
  return expected === signature;
}

export async function logAuditEvent(
  invoiceId: string,
  eventType: string,
  actorId: string | null,
  metadata: AuditMetadata | null,
  tx?: any,
) {
  const timestamp = new Date().toISOString();
  const signature = generateSignature(
    invoiceId,
    eventType,
    timestamp,
    metadata,
  );

  const client = tx || prisma;

  return client.auditEvent.create({
    data: {
      invoiceId,
      eventType,
      actorId,
      metadata: metadata ?? undefined,
      signature,
    },
  });
}

/**
 * Mask an IP address to prevent user tracking
 * @param ip - IP address to mask
 * @returns Masked IP (e.g., 192.168.***.***) or undefined
 */
function maskIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const parts = ip.split(".");
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.***.***`;
  }
  return undefined;
}

/**
 * Mask an email address to prevent identification
 * @param email - Email to mask
 * @returns Masked email (e.g., u***@example.com) or undefined
 */
function maskEmail(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const [local, domain] = email.split("@");
  if (!local || !domain) return undefined;
  return `${local.charAt(0)}***@${domain}`;
}

/**
 * Mask sensitive data in audit metadata for non-owners
 *
 * @param metadata - Raw audit metadata
 * @param isOwner - Whether requestor is the invoice owner
 * @returns Original metadata if owner, masked if not
 */
export function maskSensitiveData(
  metadata: AuditMetadata | null,
  isOwner: boolean = false,
): AuditMetadata | null {
  if (!metadata || isOwner) return metadata;

  const masked = { ...metadata };

  // Mask IP address
  if (masked.ip) {
    masked.ip = maskIp(masked.ip as string);
  }

  // Mask user agent
  if (masked.userAgent) {
    masked.userAgent = "***";
  }

  // Mask any email fields
  Object.keys(masked).forEach((key) => {
    const value = masked[key];
    if (typeof value === "string" && value.includes("@")) {
      masked[key] = maskEmail(value);
    }
  });

  return masked;
}

export function extractRequestMetadata(headers: Headers): AuditMetadata {
  return {
    ip:
      headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      headers.get("x-real-ip") ||
      undefined,
    userAgent: headers.get("user-agent") || undefined,
  };
}
