/**
 * Unit tests for audit log authorization and security
 * Verifies proper access control for invoice audit logs
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import {
  checkAuditLogAccess,
  isAdminEmail,
  ADMIN_EMAILS,
} from "@/lib/authorization";
import { maskSensitiveData } from "@/lib/audit";

describe("Audit Log Security", () => {
  let ownerUserId: string;
  let collaboratorUserId: string;
  let unauthorizedUserId: string;
  let invoiceId: string;
  const ownerEmail = `owner_${Date.now()}@example.com`;
  const collaboratorEmail = `collaborator_${Date.now()}@example.com`;
  const unauthorizedEmail = `unauthorized_${Date.now()}@example.com`;

  beforeAll(async () => {
    // Create test users
    const ownerUser = await prisma.user.create({
      data: {
        privyId: `test_owner_${Date.now()}`,
        email: ownerEmail,
      },
    });
    ownerUserId = ownerUser.id;

    const collaboratorUser = await prisma.user.create({
      data: {
        privyId: `test_collab_${Date.now()}`,
        email: collaboratorEmail,
      },
    });
    collaboratorUserId = collaboratorUser.id;

    const unauthorizedUser = await prisma.user.create({
      data: {
        privyId: `test_unauth_${Date.now()}`,
        email: unauthorizedEmail,
      },
    });
    unauthorizedUserId = unauthorizedUser.id;

    // Create test invoice
    const invoice = await prisma.invoice.create({
      data: {
        userId: ownerUserId,
        invoiceNumber: `INV_TEST_${Date.now()}`,
        clientEmail: `client_${Date.now()}@example.com`,
        description: "Test invoice for security audit",
        amount: "100.00",
        paymentLink: `link_${Date.now()}`,
      },
    });
    invoiceId = invoice.id;

    // Add collaborator
    await prisma.invoiceCollaborator.create({
      data: {
        invoiceId,
        subContractorId: collaboratorUserId,
      },
    });
  });

  afterAll(async () => {
    // Cleanup test data
    await prisma.invoiceCollaborator.deleteMany({
      where: { invoiceId },
    });
    await prisma.invoice.delete({
      where: { id: invoiceId },
    });
    await prisma.user.deleteMany({
      where: {
        id: { in: [ownerUserId, collaboratorUserId, unauthorizedUserId] },
      },
    });
  });

  describe("Authorization - checkAuditLogAccess", () => {
    it("should grant owner full access", async () => {
      const context = await checkAuditLogAccess(
        invoiceId,
        ownerUserId,
        ownerEmail
      );
      expect(context.canAccess).toBe(true);
      expect(context.isOwner).toBe(true);
      expect(context.isCollaborator).toBe(false);
      expect(context.isAdmin).toBe(false);
    });

    it("should grant collaborator access", async () => {
      const context = await checkAuditLogAccess(
        invoiceId,
        collaboratorUserId,
        collaboratorEmail
      );
      expect(context.canAccess).toBe(true);
      expect(context.isOwner).toBe(false);
      expect(context.isCollaborator).toBe(true);
      expect(context.isAdmin).toBe(false);
    });

    it("should deny unauthorized user", async () => {
      const context = await checkAuditLogAccess(
        invoiceId,
        unauthorizedUserId,
        unauthorizedEmail
      );
      expect(context.canAccess).toBe(false);
      expect(context.isOwner).toBe(false);
      expect(context.isCollaborator).toBe(false);
      expect(context.isAdmin).toBe(false);
    });

    it("should deny access to non-existent invoice", async () => {
      const context = await checkAuditLogAccess(
        "non_existent_invoice_id",
        ownerUserId,
        ownerEmail
      );
      expect(context.canAccess).toBe(false);
    });

    it("should grant admin access to any invoice", async () => {
      // Temporarily set admin email
      const adminEmail = "admin@example.com";
      vi.stubEnv("ADMIN_EMAILS", adminEmail);

      const context = await checkAuditLogAccess(
        invoiceId,
        unauthorizedUserId,
        adminEmail
      );
      expect(context.canAccess).toBe(true);
      expect(context.isAdmin).toBe(true);

      vi.unstubAllEnvs();
    });
  });

  describe("Admin Email Check", () => {
    it("should identify admin email", () => {
      const adminEmail = "admin@lancepay.com";
      vi.stubEnv("ADMIN_EMAILS", adminEmail);
      expect(isAdminEmail(adminEmail)).toBe(true);
      vi.unstubAllEnvs();
    });

    it("should handle case-insensitive admin check", () => {
      const adminEmail = "Admin@LancePay.com";
      vi.stubEnv("ADMIN_EMAILS", "admin@lancepay.com");
      expect(isAdminEmail(adminEmail)).toBe(true);
      vi.unstubAllEnvs();
    });

    it("should deny non-admin email", () => {
      vi.stubEnv("ADMIN_EMAILS", "admin@lancepay.com");
      expect(isAdminEmail("user@example.com")).toBe(false);
      vi.unstubAllEnvs();
    });
  });

  describe("Data Masking", () => {
    it("should mask IP for non-owners", () => {
      const metadata = { ip: "192.168.1.100", userAgent: "Chrome" };
      const masked = maskSensitiveData(metadata, false);

      expect(masked?.ip).toBe("192.168.***.***");
      expect(masked?.userAgent).toBe("***");
    });

    it("should not mask IP for owners", () => {
      const metadata = { ip: "192.168.1.100", userAgent: "Chrome" };
      const masked = maskSensitiveData(metadata, true);

      expect(masked?.ip).toBe("192.168.1.100");
      expect(masked?.userAgent).toBe("Chrome");
    });

    it("should mask email fields", () => {
      const metadata = { email: "user@example.com", ip: "192.168.1.100" };
      const masked = maskSensitiveData(metadata, false);

      expect(masked?.email).toBe("u***@example.com");
      expect(masked?.ip).toBe("192.168.***.***");
    });

    it("should handle null metadata", () => {
      const masked = maskSensitiveData(null, false);
      expect(masked).toBeNull();
    });

    it("should preserve non-sensitive fields", () => {
      const metadata = { action: "created", status: "pending" };
      const masked = maskSensitiveData(metadata, false);

      expect(masked?.action).toBe("created");
      expect(masked?.status).toBe("pending");
    });
  });

  describe("Security Regression Tests", () => {
    it("should prevent unauthorized user from accessing another's audit logs", async () => {
      const context = await checkAuditLogAccess(
        invoiceId,
        unauthorizedUserId,
        unauthorizedEmail
      );

      expect(context.canAccess).toBe(false);
      expect(context.userId).toBe(unauthorizedUserId);
    });

    it("should use consistent 403 response for non-existent and unauthorized", async () => {
      const nonExistent = await checkAuditLogAccess(
        "fake_invoice",
        unauthorizedUserId,
        unauthorizedEmail
      );
      const unauthorized = await checkAuditLogAccess(
        invoiceId,
        unauthorizedUserId,
        unauthorizedEmail
      );

      // Both return canAccess: false to prevent information leakage
      expect(nonExistent.canAccess).toBe(unauthorized.canAccess);
      expect(nonExistent.canAccess).toBe(false);
    });

    it("should mask PII from non-owners", () => {
      const sensitiveMetadata = {
        email: "owner@example.com",
        ip: "10.0.0.1",
        userAgent: "Mozilla/5.0",
      };

      const masked = maskSensitiveData(sensitiveMetadata, false);

      // Verify PII is obfuscated
      expect(masked?.email).toContain("***");
      expect(masked?.ip).toContain("***");
      expect(masked?.userAgent).toBe("***");

      // Verify pattern matches email domain
      expect(masked?.email).toMatch(/@example\.com$/);
    });
  });
});

describe("Audit metadata masking edge cases (#1834)", () => {
  it("masks IPv6 addresses keeping the first two hextets", () => {
    const masked = maskSensitiveData({ ip: "2001:db8:85a3::8a2e:370:7334" }, false);
    expect(masked?.ip).toBe("2001:db8:****");
  });

  it("masks IPv4-mapped IPv6 addresses as IPv4", () => {
    const masked = maskSensitiveData({ ip: "::ffff:192.168.1.100" }, false);
    expect(masked?.ip).toBe("192.168.***.***");
  });

  it("fully masks unrecognized ip values instead of dropping them", () => {
    const masked = maskSensitiveData({ ip: "not-an-ip" }, false);
    expect(masked?.ip).toBe("****");
  });

  it("masks email-like strings nested inside objects", () => {
    const metadata = {
      client: { email: "client@example.com", name: "Acme" },
      invoiceId: "inv_1",
    };
    const masked = maskSensitiveData(metadata, false);
    expect(masked?.client).toEqual({ email: "c***@example.com", name: "Acme" });
    expect(masked?.invoiceId).toBe("inv_1");
  });

  it("masks email-like strings inside arrays", () => {
    const metadata = { attendees: ["a@x.com", "plain-string", { contact: "b@y.org" }] };
    const masked = maskSensitiveData(metadata, false);
    expect(masked?.attendees).toEqual(["a***@x.com", "plain-string", { contact: "b***@y.org" }]);
  });

  it("masks nested ip and userAgent fields at any level", () => {
    const metadata = { request: { ip: "10.1.2.3", userAgent: "curl/8" } };
    const masked = maskSensitiveData(metadata, false);
    expect(masked?.request).toEqual({ ip: "10.1.***.***", userAgent: "***" });
  });

  it("returns values beyond the depth limit unchanged instead of recursing forever", () => {
    const metadata = { a: { b: { c: { d: { e: { f: { email: "deep@example.com" } } } } } } };
    const masked = maskSensitiveData(metadata, false) as Record<string, unknown>;
    // Levels a-e are masked copies; f sits beyond MAX_MASK_DEPTH and is
    // returned as the original (unmasked) subtree.
    const e = (masked.a as Record<string, unknown>).b as Record<string, unknown>;
    expect(e).toBeDefined();
    const deepEmail = JSON.stringify(masked);
    expect(deepEmail).toContain("deep@example.com");
  });

  it("terminates on cyclic metadata via the depth cap", () => {
    const cyclic: Record<string, unknown> = { ip: "1.2.3.4" };
    cyclic.self = cyclic;
    const masked = maskSensitiveData(cyclic, false) as Record<string, unknown>;
    expect(masked.ip).toBe("1.2.***.***");
  });

  it("does not mutate the original metadata object", () => {
    const metadata = { client: { email: "client@example.com" } };
    maskSensitiveData(metadata, false);
    expect(metadata.client.email).toBe("client@example.com");
  });
});
