import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, POST } from "./route";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userWebhook: { findMany: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({
  verifyAuthToken: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const mockUser = { id: "user-1", email: "user@example.com" };

function makeRequest(method: "GET" | "POST", body?: unknown, token = "valid-token"): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest("http://localhost/api/user-webhooks", {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("User Webhooks API (/api/user-webhooks)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: "privy-user-1" } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
  });

  describe("GET /api/user-webhooks", () => {
    it("returns 401 when unauthenticated", async () => {
      const res = await GET(new NextRequest("http://localhost/api/user-webhooks", { method: "GET" }));
      expect(res.status).toBe(401);
    });

    it("lists webhooks for the user and never exposes signingSecret", async () => {
      vi.mocked(prisma.userWebhook.findMany).mockResolvedValue([
        {
          id: "wh-1",
          userId: "user-1",
          targetUrl: "https://example.com/webhook",
          description: "My webhook",
          isActive: true,
          subscribedEvents: ["invoice.paid"],
          status: "ACTIVE",
          lastTriggeredAt: null,
          consecutiveFailures: 0,
          lastFailureAt: null,
          createdAt: new Date("2026-01-01"),
        },
      ] as any);

      const res = await GET(makeRequest("GET"));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.webhooks).toHaveLength(1);
      expect(json.webhooks[0].id).toBe("wh-1");
      expect(json.webhooks[0].targetUrl).toBe("https://example.com/webhook");
      expect(json.webhooks[0].signingSecret).toBeUndefined();
      expect(json.webhooks[0].previousSigningSecret).toBeUndefined();
    });
  });

  describe("POST /api/user-webhooks", () => {
    it("returns 401 when unauthenticated", async () => {
      const res = await POST(
        new NextRequest("http://localhost/api/user-webhooks", {
          method: "POST",
          body: JSON.stringify({ targetUrl: "https://example.com/webhook" }),
        }),
      );
      expect(res.status).toBe(401);
    });

    it("creates a webhook with defaults and returns signingSecret exactly once", async () => {
      const createdRecord = {
        id: "wh-created-1",
        userId: "user-1",
        targetUrl: "https://example.com/callback",
        description: null,
        signingSecret: "whsec_mockedsecret123",
        subscribedEvents: ["invoice.paid"],
        isActive: true,
        status: "ACTIVE",
        createdAt: new Date(),
      };
      vi.mocked(prisma.userWebhook.create).mockResolvedValue(createdRecord as any);

      const res = await POST(
        makeRequest("POST", {
          targetUrl: "https://example.com/callback",
        }),
      );

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.id).toBe("wh-created-1");
      expect(json.targetUrl).toBe("https://example.com/callback");
      expect(json.isActive).toBe(true);
      expect(json.status).toBe("ACTIVE");
      expect(json.subscribedEvents).toEqual(["invoice.paid"]);
      expect(json.signingSecret).toBeDefined();
      expect(typeof json.signingSecret).toBe("string");

      expect(prisma.userWebhook.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "user-1",
            targetUrl: "https://example.com/callback",
            isActive: true,
            status: "ACTIVE",
            subscribedEvents: ["invoice.paid"],
          }),
        }),
      );
    });

    it("rejects an invalid targetUrl with 400", async () => {
      const res = await POST(
        makeRequest("POST", {
          targetUrl: "not-a-valid-url",
        }),
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("Validation error");
      expect(prisma.userWebhook.create).not.toHaveBeenCalled();
    });

    it("rejects unknown subscribedEvents with 400", async () => {
      const res = await POST(
        makeRequest("POST", {
          targetUrl: "https://example.com/webhook",
          subscribedEvents: ["unknown.event.type"],
        }),
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("Validation error");
      expect(prisma.userWebhook.create).not.toHaveBeenCalled();
    });

    it("allows custom subscribedEvents and description", async () => {
      const createdRecord = {
        id: "wh-created-2",
        userId: "user-1",
        targetUrl: "https://example.com/invoice-and-payout",
        description: "Payment listener",
        signingSecret: "whsec_mockedsecret456",
        subscribedEvents: ["invoice.paid", "payout.completed"],
        isActive: false,
        status: "ACTIVE",
        createdAt: new Date(),
      };
      vi.mocked(prisma.userWebhook.create).mockResolvedValue(createdRecord as any);

      const res = await POST(
        makeRequest("POST", {
          targetUrl: "https://example.com/invoice-and-payout",
          description: "Payment listener",
          subscribedEvents: ["invoice.paid", "payout.completed"],
          isActive: false,
        }),
      );

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.description).toBe("Payment listener");
      expect(json.subscribedEvents).toEqual(["invoice.paid", "payout.completed"]);
      expect(json.isActive).toBe(false);
    });
  });
});
