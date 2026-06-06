import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../stream/route";
import * as eventBus from "../../_lib/event-bus";

// Mock dependencies
vi.mock("@/lib/auth", () => ({
  verifyAuthToken: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: vi.fn(),
  },
}));

import { verifyAuthToken } from "@/lib/auth";
import { prisma } from "@/lib/db";

describe("GET /notifications/stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventBus.clearAllSubscriptions();
  });

  it("returns 401 when not authenticated", async () => {
    const req = new NextRequest(
      "http://localhost/api/routes-b/notifications/stream",
      {
        method: "GET",
      },
    );

    const res = await GET(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 when auth token is invalid", async () => {
    const mockedVerify = vi.mocked(verifyAuthToken);
    mockedVerify.mockResolvedValue(null);

    const req = new NextRequest(
      "http://localhost/api/routes-b/notifications/stream",
      {
        method: "GET",
        headers: { authorization: "Bearer invalid-token" },
      },
    );

    const res = await GET(req);

    expect(res.status).toBe(401);
  });

  it("returns 404 when user not found", async () => {
    const mockedVerify = vi.mocked(verifyAuthToken);
    mockedVerify.mockResolvedValue({ userId: "privy-123" } as any);

    const mockedUserFind = vi.mocked(prisma.user.findUnique);
    mockedUserFind.mockResolvedValue(null);

    const req = new NextRequest(
      "http://localhost/api/routes-b/notifications/stream",
      {
        method: "GET",
        headers: { authorization: "Bearer valid-token" },
      },
    );

    const res = await GET(req);

    expect(res.status).toBe(404);
  });

  it("returns 429 when max connections exceeded", async () => {
    const mockedVerify = vi.mocked(verifyAuthToken);
    mockedVerify.mockResolvedValue({ userId: "privy-123" } as any);

    const mockedUserFind = vi.mocked(prisma.user.findUnique);
    mockedUserFind.mockResolvedValue({ id: "user-1" } as any);

    // Create 5 subscriptions to hit the limit
    for (let i = 0; i < 5; i++) {
      eventBus.subscribe("user-1", () => {});
    }

    const req = new NextRequest(
      "http://localhost/api/routes-b/notifications/stream",
      {
        method: "GET",
        headers: { authorization: "Bearer valid-token" },
      },
    );

    const res = await GET(req);

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain("Too many connections");
  });

  it("returns SSE stream with correct headers", async () => {
    const mockedVerify = vi.mocked(verifyAuthToken);
    mockedVerify.mockResolvedValue({ userId: "privy-123" } as any);

    const mockedUserFind = vi.mocked(prisma.user.findUnique);
    mockedUserFind.mockResolvedValue({ id: "user-1" } as any);

    const req = new NextRequest(
      "http://localhost/api/routes-b/notifications/stream",
      {
        method: "GET",
        headers: { authorization: "Bearer valid-token" },
      },
    );

    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
  });

  it("creates a subscription for the user", async () => {
    const mockedVerify = vi.mocked(verifyAuthToken);
    mockedVerify.mockResolvedValue({ userId: "privy-123" } as any);

    const mockedUserFind = vi.mocked(prisma.user.findUnique);
    mockedUserFind.mockResolvedValue({ id: "user-1" } as any);

    const req = new NextRequest(
      "http://localhost/api/routes-b/notifications/stream",
      {
        method: "GET",
        headers: { authorization: "Bearer valid-token" },
      },
    );

    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(eventBus.getSubscriberCount("user-1")).toBe(1);
  });

  it("allows multiple concurrent connections up to limit", async () => {
    const mockedVerify = vi.mocked(verifyAuthToken);
    mockedVerify.mockResolvedValue({ userId: "privy-123" } as any);

    const mockedUserFind = vi.mocked(prisma.user.findUnique);
    mockedUserFind.mockResolvedValue({ id: "user-1" } as any);

    // Create 5 connections
    for (let i = 0; i < 5; i++) {
      const req = new NextRequest(
        "http://localhost/api/routes-b/notifications/stream",
        {
          method: "GET",
          headers: { authorization: "Bearer valid-token" },
        },
      );

      const res = await GET(req);
      expect(res.status).toBe(200);
    }

    expect(eventBus.getSubscriberCount("user-1")).toBe(5);

    // 6th connection should fail
    const req = new NextRequest(
      "http://localhost/api/routes-b/notifications/stream",
      {
        method: "GET",
        headers: { authorization: "Bearer valid-token" },
      },
    );

    const res = await GET(req);
    expect(res.status).toBe(429);
  });

  it("allows different users to have independent connections", async () => {
    const mockedVerify = vi.mocked(verifyAuthToken);
    mockedVerify.mockResolvedValue({ userId: "privy-123" } as any);

    const mockedUserFind = vi.mocked(prisma.user.findUnique);

    // User 1 creates 5 connections
    mockedUserFind.mockResolvedValue({ id: "user-1" } as any);
    for (let i = 0; i < 5; i++) {
      const req = new NextRequest(
        "http://localhost/api/routes-b/notifications/stream",
        {
          method: "GET",
          headers: { authorization: "Bearer token-1" },
        },
      );
      const res = await GET(req);
      expect(res.status).toBe(200);
    }

    // User 2 can also create 5 connections
    mockedUserFind.mockResolvedValue({ id: "user-2" } as any);
    for (let i = 0; i < 5; i++) {
      const req = new NextRequest(
        "http://localhost/api/routes-b/notifications/stream",
        {
          method: "GET",
          headers: { authorization: "Bearer token-2" },
        },
      );
      const res = await GET(req);
      expect(res.status).toBe(200);
    }

    expect(eventBus.getSubscriberCount("user-1")).toBe(5);
    expect(eventBus.getSubscriberCount("user-2")).toBe(5);
  });

  it("sends connected event on stream start", async () => {
    const mockedVerify = vi.mocked(verifyAuthToken);
    mockedVerify.mockResolvedValue({ userId: "privy-123" } as any);

    const mockedUserFind = vi.mocked(prisma.user.findUnique);
    mockedUserFind.mockResolvedValue({ id: "user-1" } as any);

    const req = new NextRequest(
      "http://localhost/api/routes-b/notifications/stream",
      {
        method: "GET",
        headers: { authorization: "Bearer valid-token" },
      },
    );

    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();

    // Read first chunk to verify connected event
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);

    expect(text).toContain("event: connected");
    expect(text).toContain("status");

    reader.cancel();
  });

  it("handles stream cancellation and cleanup", async () => {
    const mockedVerify = vi.mocked(verifyAuthToken);
    mockedVerify.mockResolvedValue({ userId: "privy-123" } as any);

    const mockedUserFind = vi.mocked(prisma.user.findUnique);
    mockedUserFind.mockResolvedValue({ id: "user-1" } as any);

    const req = new NextRequest(
      "http://localhost/api/routes-b/notifications/stream",
      {
        method: "GET",
        headers: { authorization: "Bearer valid-token" },
      },
    );

    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(eventBus.getSubscriberCount("user-1")).toBe(1);

    // Cancel the stream
    const reader = res.body!.getReader();
    await reader.cancel();

    // Give cleanup time to run
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Subscription should be cleaned up
    expect(eventBus.getSubscriberCount("user-1")).toBe(0);
  });

  it("handles authentication errors gracefully", async () => {
    const mockedVerify = vi.mocked(verifyAuthToken);
    mockedVerify.mockRejectedValue(new Error("Auth service error"));

    const req = new NextRequest(
      "http://localhost/api/routes-b/notifications/stream",
      {
        method: "GET",
        headers: { authorization: "Bearer valid-token" },
      },
    );

    const res = await GET(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
  });

  it("handles database errors gracefully", async () => {
    const mockedVerify = vi.mocked(verifyAuthToken);
    mockedVerify.mockResolvedValue({ userId: "privy-123" } as any);

    const mockedUserFind = vi.mocked(prisma.user.findUnique);
    mockedUserFind.mockRejectedValue(new Error("Database error"));

    const req = new NextRequest(
      "http://localhost/api/routes-b/notifications/stream",
      {
        method: "GET",
        headers: { authorization: "Bearer valid-token" },
      },
    );

    const res = await GET(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
  });
});
