import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ verifyAuthToken: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    auditEvent: { findMany: vi.fn(), count: vi.fn() },
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { verifyAuthToken } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { GET } from "../route";

const mockedVerify = vi.mocked(verifyAuthToken);
const userDelegate = prisma.user as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
};
const auditEventDelegate = prisma.auditEvent as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
};

const BASE_URL = "http://localhost/api/routes-d/activity-feed";

function makeGet(search?: string, authHeader: string | null = "Bearer token") {
  const url = search ? `${BASE_URL}?${search}` : BASE_URL;
  return new NextRequest(url, {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

describe("GET /api/routes-d/activity-feed", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 401 when unauthenticated", async () => {
    mockedVerify.mockResolvedValue(null as never);
    const res = await GET(makeGet(undefined, null));
    expect(res.status).toBe(401);
  });

  it("returns empty feed when no events exist", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    auditEventDelegate.count.mockResolvedValue(0);
    auditEventDelegate.findMany.mockResolvedValue([]);

    const res = await GET(makeGet());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.feed).toEqual([]);
    expect(body.pagination.total).toBe(0);
    expect(body.pagination.limit).toBe(20);
    expect(body.pagination.skip).toBe(0);
    expect(body.pagination.returned).toBe(0);
  });

  it("returns paginated activity feed with default pagination", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    auditEventDelegate.count.mockResolvedValue(100);
    auditEventDelegate.findMany.mockResolvedValue([
      {
        id: "evt-1",
        invoiceId: "inv-1",
        eventType: "invoice.created",
        actorId: "user-1",
        metadata: { amount: 1000 },
        signature: "sig-1",
        createdAt: new Date("2026-01-15T10:00:00Z"),
      },
      {
        id: "evt-2",
        invoiceId: "inv-1",
        eventType: "invoice.paid",
        actorId: "user-2",
        metadata: { paidAt: "2026-01-16T00:00:00Z" },
        signature: "sig-2",
        createdAt: new Date("2026-01-16T14:30:00Z"),
      },
    ]);
    userDelegate.findMany.mockResolvedValue([
      { id: "user-1", email: "alice@example.com", name: "Alice" },
      { id: "user-2", email: "bob@example.com", name: "Bob" },
    ]);

    const res = await GET(makeGet());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.feed).toHaveLength(2);
    expect(body.feed[0].eventType).toBe("invoice.paid");
    expect(body.feed[0].actor?.email).toBe("bob@example.com");
    expect(body.pagination.total).toBe(100);
    expect(body.pagination.limit).toBe(20);
    expect(body.pagination.skip).toBe(0);
    expect(body.pagination.returned).toBe(2);
  });

  it("respects custom limit parameter", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    auditEventDelegate.count.mockResolvedValue(100);
    auditEventDelegate.findMany.mockResolvedValue([]);

    await GET(makeGet("limit=50"));

    expect(auditEventDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 50,
      }),
    );
  });

  it("caps limit to maximum of 100", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    auditEventDelegate.count.mockResolvedValue(100);
    auditEventDelegate.findMany.mockResolvedValue([]);

    await GET(makeGet("limit=500"));

    expect(auditEventDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
      }),
    );
  });

  it("enforces minimum limit of 1", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    auditEventDelegate.count.mockResolvedValue(100);
    auditEventDelegate.findMany.mockResolvedValue([]);

    await GET(makeGet("limit=0"));

    expect(auditEventDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 1,
      }),
    );
  });

  it("respects skip parameter for pagination", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    auditEventDelegate.count.mockResolvedValue(100);
    auditEventDelegate.findMany.mockResolvedValue([]);

    await GET(makeGet("skip=40"));

    expect(auditEventDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 40,
      }),
    );
  });

  it("enforces non-negative skip", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    auditEventDelegate.count.mockResolvedValue(100);
    auditEventDelegate.findMany.mockResolvedValue([]);

    await GET(makeGet("skip=-10"));

    expect(auditEventDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 0,
      }),
    );
  });

  it("filters by eventType", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    auditEventDelegate.count.mockResolvedValue(50);
    auditEventDelegate.findMany.mockResolvedValue([]);

    await GET(makeGet("eventType=invoice.paid"));

    expect(auditEventDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          eventType: "invoice.paid",
        }),
      }),
    );
  });

  it("filters by since date", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    auditEventDelegate.count.mockResolvedValue(30);
    auditEventDelegate.findMany.mockResolvedValue([]);

    const sinceDate = "2026-01-10T00:00:00Z";
    await GET(makeGet(`since=${encodeURIComponent(sinceDate)}`));

    expect(auditEventDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({
            gte: expect.any(Date),
          }),
        }),
      }),
    );
  });

  it("filters by until date", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    auditEventDelegate.count.mockResolvedValue(30);
    auditEventDelegate.findMany.mockResolvedValue([]);

    const untilDate = "2026-02-01T00:00:00Z";
    await GET(makeGet(`until=${encodeURIComponent(untilDate)}`));

    expect(auditEventDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({
            lte: expect.any(Date),
          }),
        }),
      }),
    );
  });

  it("filters by both since and until dates", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    auditEventDelegate.count.mockResolvedValue(20);
    auditEventDelegate.findMany.mockResolvedValue([]);

    const sinceDate = "2026-01-10T00:00:00Z";
    const untilDate = "2026-02-01T00:00:00Z";
    await GET(
      makeGet(
        `since=${encodeURIComponent(sinceDate)}&until=${encodeURIComponent(untilDate)}`,
      ),
    );

    expect(auditEventDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({
            gte: expect.any(Date),
            lte: expect.any(Date),
          }),
        }),
      }),
    );
  });

  it("ignores invalid date filters", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    auditEventDelegate.count.mockResolvedValue(100);
    auditEventDelegate.findMany.mockResolvedValue([]);

    await GET(makeGet("since=invalid-date&until=also-invalid"));

    expect(auditEventDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({
          createdAt: expect.anything(),
        }),
      }),
    );
  });

  it("returns events sorted by createdAt descending", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    auditEventDelegate.count.mockResolvedValue(100);
    auditEventDelegate.findMany.mockResolvedValue([]);

    await GET(makeGet());

    expect(auditEventDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: "desc" },
      }),
    );
  });

  it("handles events with null actorId", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    auditEventDelegate.count.mockResolvedValue(1);
    auditEventDelegate.findMany.mockResolvedValue([
      {
        id: "evt-1",
        invoiceId: "inv-1",
        eventType: "invoice.created",
        actorId: null,
        metadata: null,
        signature: "sig-1",
        createdAt: new Date("2026-01-15T10:00:00Z"),
      },
    ]);
    userDelegate.findMany.mockResolvedValue([]);

    const res = await GET(makeGet());
    const body = await res.json();

    expect(body.feed[0].actor).toBeNull();
    expect(body.feed[0].metadata).toBeNull();
  });

  it("fetches actor details for non-null actorIds", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    auditEventDelegate.count.mockResolvedValue(1);
    auditEventDelegate.findMany.mockResolvedValue([
      {
        id: "evt-1",
        invoiceId: "inv-1",
        eventType: "invoice.paid",
        actorId: "user-2",
        metadata: { amount: 500 },
        signature: "sig-1",
        createdAt: new Date("2026-01-15T10:00:00Z"),
      },
    ]);
    userDelegate.findMany.mockResolvedValue([
      { id: "user-2", email: "actor@example.com", name: "Actor" },
    ]);

    const res = await GET(makeGet());
    const body = await res.json();

    expect(userDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["user-2"] } },
      }),
    );
    expect(body.feed[0].actor).toEqual({
      id: "user-2",
      email: "actor@example.com",
      name: "Actor",
    });
  });

  it("handles multiple filters together", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    auditEventDelegate.count.mockResolvedValue(10);
    auditEventDelegate.findMany.mockResolvedValue([]);

    const query = `eventType=invoice.paid&since=2026-01-10T00:00:00Z&limit=25&skip=10`;
    await GET(makeGet(query));

    expect(auditEventDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          eventType: "invoice.paid",
          createdAt: expect.objectContaining({
            gte: expect.any(Date),
          }),
        }),
        limit: undefined,
        take: 25,
        skip: 10,
      }),
    );
  });

  it("ensures user ownership is checked", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    auditEventDelegate.count.mockResolvedValue(100);
    auditEventDelegate.findMany.mockResolvedValue([]);

    await GET(makeGet());

    expect(auditEventDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          invoice: expect.objectContaining({
            userId: "user-1",
          }),
        }),
      }),
    );
  });

  it("returns 500 on database error", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockRejectedValue(
      new Error("DB connection failed"),
    );

    const res = await GET(makeGet());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch activity feed");
  });
});
