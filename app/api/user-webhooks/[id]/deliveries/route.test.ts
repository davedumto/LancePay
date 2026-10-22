import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userWebhook: { findUnique: vi.fn() },
    webhookDelivery: { count: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock("@/lib/auth", () => ({ verifyAuthToken: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";

const mockUser = { id: "user-1", privyId: "privy-1", role: "freelancer" };
const mockWebhook = {
  id: "webhook-1",
  userId: "user-1",
  targetUrl: "https://example.com/webhook",
};
const mockDeliveries = [
  {
    id: "del-1",
    webhookId: "webhook-1",
    eventType: "invoice.paid",
    status: "delivered",
    attemptCount: 1,
    lastStatusCode: 200,
    lastError: null,
    createdAt: new Date(),
  },
  {
    id: "del-2",
    webhookId: "webhook-1",
    eventType: "invoice.created",
    status: "failed",
    attemptCount: 3,
    lastStatusCode: 500,
    lastError: "Internal server error",
    createdAt: new Date(),
  },
];

function makeRequest(
  url = "http://localhost/api/user-webhooks/webhook-1/deliveries",
  withAuth = true,
) {
  return new NextRequest(url, {
    method: "GET",
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
  vi.mocked(prisma.webhookDelivery.count).mockResolvedValue(2);
  vi.mocked(prisma.webhookDelivery.findMany).mockResolvedValue(
    mockDeliveries as any,
  );
});

describe("GET /api/user-webhooks/[id]/deliveries", () => {
  it("returns deliveries list and pagination metadata for the webhook owner", async () => {
    const res = await GET(makeRequest(), context());
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.deliveries).toHaveLength(2);
    expect(data.deliveries[0].attemptCount).toBe(1);
    expect(data.deliveries[0].lastStatusCode).toBe(200);
    expect(data.deliveries[1].lastError).toBe("Internal server error");
    expect(data.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 2,
      totalPages: 1,
    });
  });

  it("supports filtering by status and custom pagination", async () => {
    const url =
      "http://localhost/api/user-webhooks/webhook-1/deliveries?status=failed&page=2&limit=10";
    const res = await GET(makeRequest(url), context());
    expect(res.status).toBe(200);

    expect(prisma.webhookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { webhookId: "webhook-1", status: "failed" },
        skip: 10,
        take: 10,
      }),
    );
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await GET(
      makeRequest(
        "http://localhost/api/user-webhooks/webhook-1/deliveries",
        false,
      ),
      context(),
    );
    expect(res.status).toBe(401);
  });

  it("rejects non-owner non-admin with 403", async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue({
      id: "webhook-1",
      userId: "other-user",
    } as any);

    const res = await GET(makeRequest(), context());
    expect(res.status).toBe(403);
  });

  it("returns 404 when webhook does not exist", async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue(null);

    const res = await GET(makeRequest(), context());
    expect(res.status).toBe(404);
  });
});
