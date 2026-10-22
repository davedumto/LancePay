import { describe, it, expect, vi, beforeEach } from "vitest";
import { PATCH, DELETE } from "./route";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userWebhook: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
    webhookDelivery: { deleteMany: vi.fn() },
    $transaction: vi.fn((fns) => Promise.all(fns)),
  },
}));
vi.mock("@/lib/auth", () => ({ verifyAuthToken: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";

const mockUser = { id: "user-1", role: "freelancer", email: "user@test.com" };
const mockClaims = { userId: "privy-1" };
const mockWebhook = {
  id: "wh-1",
  userId: "user-1",
  targetUrl: "https://example.com/webhook",
  signingSecret: "secret-xyz",
  description: "Original description",
  isActive: true,
  subscribedEvents: ["invoice.paid"],
};

function makeRequest(
  method: string,
  body?: unknown,
  withAuth = true,
): NextRequest {
  return new NextRequest("http://localhost/api/user-webhooks/wh-1", {
    method,
    headers: {
      ...(withAuth ? { authorization: "Bearer token" } : {}),
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: "wh-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any);
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
  vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue(
    mockWebhook as any,
  );
  vi.mocked(prisma.userWebhook.update).mockImplementation(
    async ({ data }: any) => ({
      ...mockWebhook,
      ...data,
    }),
  );
  vi.mocked(prisma.userWebhook.delete).mockResolvedValue(mockWebhook as any);
  vi.mocked(prisma.webhookDelivery.deleteMany).mockResolvedValue({
    count: 5,
  } as any);
  vi.mocked(prisma.$transaction).mockImplementation(async (arg: any) => {
    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }
    return arg(prisma);
  });
});

describe("PATCH /api/user-webhooks/[id]", () => {
  it("updates targetUrl, subscribedEvents, isActive, and description", async () => {
    const updatePayload = {
      targetUrl: "https://api.myclient.com/hooks",
      subscribedEvents: ["invoice.created", "invoice.paid"],
      isActive: false,
      description: "Updated Webhook Description",
    };

    const res = await PATCH(makeRequest("PATCH", updatePayload), params);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.webhook.targetUrl).toBe("https://api.myclient.com/hooks");
    expect(json.webhook.subscribedEvents).toEqual([
      "invoice.created",
      "invoice.paid",
    ]);
    expect(json.webhook.isActive).toBe(false);
    expect(json.webhook.description).toBe("Updated Webhook Description");

    const updateCall = vi.mocked(prisma.userWebhook.update).mock
      .calls[0][0] as any;
    expect(updateCall.data.targetUrl).toBe("https://api.myclient.com/hooks");
    expect(updateCall.data.isActive).toBe(false);
  });

  it("rejects attempt to modify signingSecret directly", async () => {
    const res = await PATCH(
      makeRequest("PATCH", { signingSecret: "hacked_secret" }),
      params,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("signingSecret cannot be modified directly");
    expect(vi.mocked(prisma.userWebhook.update)).not.toHaveBeenCalled();
  });

  it("rejects invalid targetUrl format", async () => {
    const res = await PATCH(
      makeRequest("PATCH", { targetUrl: "invalid-url" }),
      params,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("valid URL");
    expect(vi.mocked(prisma.userWebhook.update)).not.toHaveBeenCalled();
  });

  it("forbids updating a webhook belonging to another user", async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue({
      ...mockWebhook,
      userId: "other-user",
    } as any);

    const res = await PATCH(makeRequest("PATCH", { isActive: false }), params);
    expect(res.status).toBe(403);
    expect(vi.mocked(prisma.userWebhook.update)).not.toHaveBeenCalled();
  });

  it("returns 404 if webhook not found", async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue(null);
    const res = await PATCH(makeRequest("PATCH", { isActive: false }), params);
    expect(res.status).toBe(404);
  });

  it("returns 401 if unauthorized", async () => {
    const res = await PATCH(
      makeRequest("PATCH", { isActive: false }, false),
      params,
    );
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/user-webhooks/[id]", () => {
  it("deletes the webhook and cascades WebhookDelivery rows", async () => {
    const res = await DELETE(makeRequest("DELETE"), params);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.message).toBe("Webhook deleted successfully");

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.webhookDelivery.deleteMany).toHaveBeenCalledWith({
      where: { webhookId: "wh-1" },
    });
    expect(prisma.userWebhook.delete).toHaveBeenCalledWith({
      where: { id: "wh-1" },
    });
  });

  it("forbids deleting a webhook belonging to another user", async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue({
      ...mockWebhook,
      userId: "other-user",
    } as any);

    const res = await DELETE(makeRequest("DELETE"), params);
    expect(res.status).toBe(403);
    expect(prisma.userWebhook.delete).not.toHaveBeenCalled();
  });

  it("returns 404 when webhook does not exist", async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue(null);
    const res = await DELETE(makeRequest("DELETE"), params);
    expect(res.status).toBe(404);
  });

  it("returns 401 when unauthorized", async () => {
    const res = await DELETE(makeRequest("DELETE", undefined, false), params);
    expect(res.status).toBe(401);
  });
});
