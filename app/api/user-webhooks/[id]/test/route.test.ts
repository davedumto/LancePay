import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { computeWebhookSignature } from "@/lib/webhook-signature";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userWebhook: { findUnique: vi.fn() },
    webhookDelivery: { create: vi.fn() },
  },
}));
vi.mock("@/lib/auth", () => ({ verifyAuthToken: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";

const mockUser = { id: "user-1", privyId: "privy-1", role: "freelancer" };
const mockWebhook = {
  id: "webhook-1",
  userId: "user-1",
  targetUrl: "https://example.com/webhook",
  signingSecret: "secret-1234567890",
};

function makeRequest(
  url = "http://localhost/api/user-webhooks/webhook-1/test",
  withAuth = true,
) {
  return new NextRequest(url, {
    method: "POST",
    headers: withAuth ? { authorization: "Bearer test-token" } : {},
  });
}

const context = (id = "webhook-1") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: "privy-1" } as any);
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
  vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue(
    mockWebhook as any,
  );
  vi.mocked(prisma.webhookDelivery.create).mockImplementation(
    async ({ data }: any) => ({
      id: "delivery-test-1",
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  );
});

describe("POST /api/user-webhooks/[id]/test", () => {
  it("fires test ping signed with webhook signingSecret and records delivery with eventType test.ping", async () => {
    let capturedHeaders: HeadersInit | undefined;
    let capturedBody: any;

    const mockFetch = vi
      .fn()
      .mockImplementation(async (url: string, init: any) => {
        capturedHeaders = init?.headers;
        capturedBody = init?.body;
        return {
          ok: true,
          status: 200,
          text: async () => "OK",
        };
      });
    vi.stubGlobal("fetch", mockFetch);

    const res = await POST(makeRequest(), context());
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.eventType).toBe("test.ping");
    expect(data.statusCode).toBe(200);
    expect(data.deliveryId).toBe("delivery-test-1");
    expect(typeof data.latencyMs).toBe("number");

    // Verify signature header matches computeWebhookSignature with real secret
    const signature = (capturedHeaders as Record<string, string>)?.[
      "X-Webhook-Signature"
    ];
    const expectedSig = computeWebhookSignature(
      capturedBody,
      mockWebhook.signingSecret,
    );
    expect(signature).toBe(expectedSig);

    // Verify Prisma recorded WebhookDelivery with eventType test.ping
    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        webhookId: "webhook-1",
        eventType: "test.ping",
        status: "delivered",
        lastStatusCode: 200,
      }),
    });
  });

  it("handles remote endpoint failure gracefully and returns status code and error to caller", async () => {
    const mockFetch = vi.fn().mockImplementation(async () => ({
      ok: false,
      status: 502,
      text: async () => "Bad Gateway",
    }));
    vi.stubGlobal("fetch", mockFetch);

    const res = await POST(makeRequest(), context());
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.statusCode).toBe(502);

    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        webhookId: "webhook-1",
        eventType: "test.ping",
        status: "failed",
        lastStatusCode: 502,
      }),
    });
  });

  it("handles remote network error or timeout", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValue(new Error("Connection timed out"));
    vi.stubGlobal("fetch", mockFetch);

    const res = await POST(makeRequest(), context());
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toContain("timed out");

    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "failed",
        lastError: "Connection timed out",
      }),
    });
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await POST(
      makeRequest("http://localhost/api/user-webhooks/webhook-1/test", false),
      context(),
    );
    expect(res.status).toBe(401);
  });

  it("rejects non-owner non-admin with 403", async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue({
      id: "webhook-1",
      userId: "other-user",
    } as any);

    const res = await POST(makeRequest(), context());
    expect(res.status).toBe(403);
  });

  it("returns 404 when webhook does not exist", async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue(null);

    const res = await POST(makeRequest(), context());
    expect(res.status).toBe(404);
  });
});
