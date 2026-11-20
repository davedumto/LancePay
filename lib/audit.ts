import crypto, { createHmac } from "crypto";
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
    },
  });
}

/**
 * Mask an IP address to prevent user tracking.
 *
 * - IPv4 (`a.b.c.d`) keeps the first two octets: `a.b.***.***`
 * - IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is masked as IPv4
 * - Other IPv6 addresses keep the first two hextets: `h1:h2:****`
 * - Anything else is fully masked as `****`
 *
 * @param ip - IP address to mask
 * @returns Masked IP or undefined for empty input
 */
function maskIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;

  const ipv4Mapped = ip.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (ipv4Mapped) {
    return maskIp(ipv4Mapped[1]);
  }

  const parts = ip.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    return `${parts[0]}.${parts[1]}.***.***`;
  }

  if (ip.includes(":")) {
    const hextets = ip.split(":").filter(Boolean);
    if (hextets.length >= 2) {
      return `${hextets[0]}:${hextets[1]}:****`;
    }
    return "****";
  }

  return "****";
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

/** Maximum depth maskSensitiveData will recurse into nested metadata. */
const MAX_MASK_DEPTH = 5;

/**
 * Recursively mask PII inside metadata: `ip` fields via maskIp, `userAgent`
 * fields are blanked, and any string containing `@` is treated as an email
 * and masked via maskEmail — at every nesting level, including inside arrays.
 * Depth is capped to stay safe on deeply nested or cyclic structures.
 */
function maskNode(value: unknown, depth: number): unknown {
  if (depth > MAX_MASK_DEPTH) return value;

  if (Array.isArray(value)) {
    return value.map((item) => maskNode(item, depth + 1));
  }

  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "ip" && typeof child === "string") {
        out[key] = maskIp(child);
      } else if (key === "userAgent" && typeof child === "string") {
        out[key] = "***";
      } else {
        out[key] = maskNode(child, depth + 1);
      }
    }
    return out;
  }

  if (typeof value === "string" && value.includes("@")) {
    return maskEmail(value);
  }

  return value;
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

  return maskNode(metadata, 0) as AuditMetadata;
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
