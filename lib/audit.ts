import crypto, { createHmac } from "crypto";
import { prisma } from "@/lib/db";
import { resolveClientIp } from "@/lib/client-ip";

const AUDIT_SECRET =
  process.env.AUDIT_SECRET || "default-audit-secret-change-in-production";

interface AuditMetadata {
  ip?: string;
  userAgent?: string;
  [key: string]: unknown;
}

/**
 * Recursively sorts object keys so the signed payload is independent of
 * JSON key order. Arrays keep their order; primitives pass through.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value ?? {}));
}

/**
 * Signed payload layout (HMAC-SHA256 keyed by AUDIT_SECRET):
 *
 *   `${invoiceId}:${eventType}:${timestamp}:${canonicalJSON(metadata)}`
 *
 * - `timestamp` is the event's ISO-8601 `createdAt`, persisted on the
 *   AuditEvent row by `logAuditEvent` so signatures remain verifiable
 *   after the fact.
 * - `canonicalJSON` is `JSON.stringify` over metadata with all object
 *   keys sorted recursively, so verification does not depend on the key
 *   order the metadata happened to be stored or retrieved in.
 */
export function generateSignature(
  invoiceId: string,
  eventType: string,
  timestamp: string,
  metadata: AuditMetadata | null,
): string {
  const payload = `${invoiceId}:${eventType}:${timestamp}:${stableStringify(metadata || {})}`;
  return createHmac("sha256", AUDIT_SECRET).update(payload).digest("hex");
}

/**
 * Verifies an audit log event signature using constant-time comparison.
 *
 * Why constant-time comparison matters here:
 * Even though this verification helper may be latent or currently unused in public user paths,
 * standard string equality (`===`) short-circuits on the first mismatched byte, leaking timing
 * information observable over network requests. An attacker could exploit such timing differences
 * to iteratively forge valid HMAC signatures byte-by-byte. Using `crypto.timingSafeEqual`
 * ensures comparisons execute in constant time regardless of where mismatches occur.
 *
 * We also guard against length mismatches since `timingSafeEqual` throws if buffer lengths differ.
 */
export function verifySignature(
  invoiceId: string,
  eventType: string,
  timestamp: string,
  metadata: AuditMetadata | null,
  signature: string,
): boolean {
  if (!signature || typeof signature !== "string") {
    return false;
  }

  const expected = generateSignature(invoiceId, eventType, timestamp, metadata);
  const expectedBuf = Buffer.from(expected, "utf8");
  const suppliedBuf = Buffer.from(signature, "utf8");

  if (expectedBuf.length !== suppliedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, suppliedBuf);
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
      // Persist the exact timestamp that was signed so verifySignature can
      // reproduce the payload from the stored row.
      createdAt: new Date(timestamp),
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
  const ip = resolveClientIp(headers);
  return {
    ip: ip === 'anonymous' ? undefined : ip,
    userAgent: headers.get("user-agent") || undefined,
  };
}
