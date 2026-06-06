import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { clearCache } from "../_lib/cache";
import { ROUTES_B_ERROR_CODES, errorResponse } from "../_lib/errors";
import { emitInvoicePaid } from "../_lib/events";

vi.mock("@/lib/auth", () => ({ verifyAuthToken: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
    user: { findUnique: vi.fn() },
    bankAccount: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    invoice: { findMany: vi.fn(), groupBy: vi.fn() },
    transaction: { aggregate: vi.fn(), count: vi.fn() },
    contact: { findMany: vi.fn(), count: vi.fn() },
    tag: { findMany: vi.fn(), count: vi.fn() },
  },
}));
vi.mock("../_lib/authz", () => ({
  requireScope: vi.fn(),
  RoutesBForbiddenError: class RoutesBForbiddenError extends Error {
    code = "FORBIDDEN";
  },
}));

import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { requireScope } from "../_lib/authz";

describe("routes-b issues 538/552/547/546", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
    vi.useRealTimers();
  });

  it("538: PATCH bank-accounts/[id] sets default atomically", async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({
      userId: "privy-1",
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "user-1",
    } as never);
    vi.mocked(prisma.bankAccount.findUnique).mockResolvedValue({
      id: "acct-2",
      userId: "user-1",
    } as never);
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) =>
      fn({
        bankAccount: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          update: vi.fn().mockResolvedValue({ id: "acct-2", isDefault: true }),
        },
      }),
    );

    const { PATCH } = await import("../bank-accounts/[id]/route");
    const req = new NextRequest(
      "http://localhost/api/routes-b/bank-accounts/acct-2",
      {
        method: "PATCH",
        headers: {
          authorization: "Bearer t",
          "content-type": "application/json",
        },
        body: JSON.stringify({ isDefault: true }),
      },
    );
    const res = await PATCH(req, { params: Promise.resolve({ id: "acct-2" }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.bankAccount.id).toBe("acct-2");
    expect(json.bankAccount.isDefault).toBe(true);
  });

  it("538: DELETE default account promotes most recently used remaining account and handles empty remainder", async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({
      userId: "privy-1",
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "user-1",
    } as never);
    vi.mocked(prisma.bankAccount.findUnique).mockResolvedValue({
      id: "acct-1",
      userId: "user-1",
    } as never);
    vi.mocked(prisma.$transaction)
      .mockImplementationOnce(async (fn: any) =>
        fn({
          bankAccount: {
            delete: vi
              .fn()
              .mockResolvedValue({ id: "acct-1", isDefault: true }),
            findMany: vi.fn().mockResolvedValue([
              {
                id: "acct-2",
                createdAt: new Date("2026-01-01T00:00:00.000Z"),
                withdrawals: [],
              },
              {
                id: "acct-3",
                createdAt: new Date("2026-01-01T00:00:00.000Z"),
                withdrawals: [
                  { createdAt: new Date("2026-02-01T00:00:00.000Z") },
                ],
              },
            ]),
            updateMany: vi.fn().mockResolvedValue({ count: 2 }),
            update: vi.fn().mockResolvedValue({ id: "acct-3" }),
          },
        }),
      )
      .mockImplementationOnce(async (fn: any) =>
        fn({
          bankAccount: {
            delete: vi
              .fn()
              .mockResolvedValue({ id: "acct-1", isDefault: true }),
            findMany: vi.fn().mockResolvedValue([]),
            updateMany: vi.fn(),
            update: vi.fn(),
          },
        }),
      );

    const { DELETE } = await import("../bank-accounts/[id]/route");
    const req = new NextRequest(
      "http://localhost/api/routes-b/bank-accounts/acct-1",
      {
        method: "DELETE",
        headers: { authorization: "Bearer t" },
      },
    );

    const first = await DELETE(req, {
      params: Promise.resolve({ id: "acct-1" }),
    });
    const firstJson = await first.json();
    expect(first.status).toBe(200);
    expect(firstJson.promotedId).toBe("acct-3");

    const second = await DELETE(req, {
      params: Promise.resolve({ id: "acct-1" }),
    });
    const secondJson = await second.json();
    expect(second.status).toBe(200);
    expect(secondJson.promotedId).toBeNull();
  });

  it("552: error helper shape/code enum and requestId passthrough in migrated handlers", async () => {
    expect(ROUTES_B_ERROR_CODES).toEqual([
      "BAD_REQUEST",
      "UNAUTHORIZED",
      "FORBIDDEN",
      "NOT_FOUND",
      "CONFLICT",
      "RATE_LIMITED",
      "INTERNAL",
    ]);

    const envelope = errorResponse(
      "BAD_REQUEST",
      "Invalid",
      { q: "required" },
      400,
      "req-1",
    );
    expect(await envelope.json()).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "Invalid",
        fields: { q: "required" },
      },
      requestId: "req-1",
    });

    vi.mocked(requireScope).mockRejectedValue(new Error("boom") as never);
    const { GET: statsGet } = await import("../stats/route");
    const statsRes = await statsGet(
      new NextRequest("http://localhost/api/routes-b/stats", {
        headers: { "x-request-id": "req-stats" },
      }),
    );
    const statsJson = await statsRes.json();
    expect(statsJson.requestId).toBe("req-stats");
  });

  it("547: top-months cache handles cold/warm/expiry/bust and separates users", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
    vi.mocked(verifyAuthToken).mockImplementation(
      async (token: string) => ({ userId: token }) as never,
    );
    vi.mocked(prisma.user.findUnique).mockImplementation(
      async ({ where }: any) => ({ id: where.privyId }) as never,
    );
    vi.mocked(prisma.invoice.findMany).mockResolvedValue([
      { amount: 100, paidAt: new Date("2026-01-05T00:00:00.000Z") },
      { amount: 200, paidAt: new Date("2026-02-05T00:00:00.000Z") },
    ] as never);

    const { GET } = await import("../analytics/top-months/route");

    const reqUser1 = new NextRequest(
      "http://localhost/api/routes-b/analytics/top-months",
      {
        headers: { authorization: "Bearer user-1" },
      },
    );
    const reqUser2 = new NextRequest(
      "http://localhost/api/routes-b/analytics/top-months",
      {
        headers: { authorization: "Bearer user-2" },
      },
    );

    const cold = await GET(reqUser1);
    expect(cold.headers.get("X-Cache")).toBe("MISS");
    await GET(reqUser1);
    expect(prisma.invoice.findMany).toHaveBeenCalledTimes(1);

    await GET(reqUser2);
    expect(prisma.invoice.findMany).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    await GET(reqUser1);
    expect(prisma.invoice.findMany).toHaveBeenCalledTimes(3);

    emitInvoicePaid({ userId: "user-1", invoiceId: "inv-1" });
    await GET(reqUser1);
    expect(prisma.invoice.findMany).toHaveBeenCalledTimes(4);
  });

  it("546: withdrawals supports groupBy values, empty result, and year-boundary buckets", async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({
      userId: "privy-1",
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "user-1",
    } as never);
    vi.mocked(prisma.$queryRawUnsafe)
      .mockResolvedValueOnce([
        {
          bucket: new Date("2025-01-01T00:00:00.000Z"),
          count: 2n,
          total_amount: 100,
          avg_amount: 50,
        },
      ] as never)
      .mockResolvedValueOnce([
        {
          bucket: new Date("2025-12-29T00:00:00.000Z"),
          count: 1n,
          total_amount: 30,
          avg_amount: 30,
        },
      ] as never)
      .mockResolvedValueOnce([] as never);

    const { GET } = await import("../analytics/withdrawals/route");
    const monthRes = await GET(
      new NextRequest(
        "http://localhost/api/routes-b/analytics/withdrawals?groupBy=month&from=2025-01-01&to=2025-02-01",
        {
          headers: { authorization: "Bearer t" },
        },
      ),
    );
    const weekRes = await GET(
      new NextRequest(
        "http://localhost/api/routes-b/analytics/withdrawals?groupBy=week&from=2025-12-20&to=2026-01-10",
        {
          headers: { authorization: "Bearer t" },
        },
      ),
    );
    const dayRes = await GET(
      new NextRequest(
        "http://localhost/api/routes-b/analytics/withdrawals?groupBy=day&from=2025-01-01&to=2025-01-01",
        {
          headers: { authorization: "Bearer t" },
        },
      ),
    );

    const monthJson = await monthRes.json();
    const weekJson = await weekRes.json();
    const dayJson = await dayRes.json();

    expect(monthJson.groupBy).toBe("month");
    expect(monthJson.buckets[0]).toEqual({
      bucket: "2025-01-01T00:00:00.000Z",
      count: 2,
      totalAmount: 100,
      avgAmount: 50,
    });
    expect(weekJson.groupBy).toBe("week");
    expect(weekJson.buckets[0].bucket).toBe("2025-12-29T00:00:00.000Z");
    expect(dayJson.groupBy).toBe("day");
    expect(dayJson.buckets).toEqual([]);
  });
});
