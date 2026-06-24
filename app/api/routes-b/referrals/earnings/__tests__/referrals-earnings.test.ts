import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ verifyAuthToken: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    referralEarning: { findMany: vi.fn(), count: vi.fn() },
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { verifyAuthToken } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { GET } from "../route";

const mockedVerify = vi.mocked(verifyAuthToken);
const userDelegate = prisma.user as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
};
const referralEarningDelegate = prisma.referralEarning as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
};

const BASE_URL = "http://localhost/api/routes-b/referrals/earnings";

function makeGetQuery(query?: string, authHeader: string | null = "Bearer token") {
  const url = query ? `${BASE_URL}?${query}` : BASE_URL;
  return new NextRequest(url, {
    method: "GET",
    headers: authHeader
      ? { authorization: authHeader }
      : {},
  });
}

describe("GET /api/routes-b/referrals/earnings", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 401 when unauthenticated", async () => {
    mockedVerify.mockResolvedValue(null as never);
    const res = await GET(makeGetQuery(undefined, null));
    expect(res.status).toBe(401);
  });

  it("returns 401 when invalid token", async () => {
    mockedVerify.mockResolvedValue(null as never);
    const res = await GET(makeGetQuery(undefined, "Bearer bad-token"));
    expect(res.status).toBe(401);
  });

  it("returns earnings for authenticated user", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    referralEarningDelegate.findMany.mockResolvedValue([
      {
        id: "re-1",
        referredUserId: "user-2",
        invoiceId: "inv-1",
        amountUsdc: { toString: () => "10.5" },
        platformFee: { toString: () => "0.5" },
        status: "earned",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    referralEarningDelegate.count.mockResolvedValue(1);

    const res = await GET(makeGetQuery());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.earnings).toHaveLength(1);
    expect(body.earnings[0].id).toBe("re-1");
    expect(body.earnings[0].amountUsdc).toBe("10.5");
    expect(body.pagination.total).toBe(1);
  });

  it("filters by status parameter", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    referralEarningDelegate.findMany.mockResolvedValue([]);
    referralEarningDelegate.count.mockResolvedValue(0);

    await GET(makeGetQuery("status=paid"));
    expect(referralEarningDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ referrerId: "user-1", status: "paid" }),
      }),
    );
  });

  it("applies default limit and offset", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    referralEarningDelegate.findMany.mockResolvedValue([]);
    referralEarningDelegate.count.mockResolvedValue(0);

    await GET(makeGetQuery());
    expect(referralEarningDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 50,
        skip: 0,
      }),
    );
  });

  it("respects custom limit capped at 100", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    referralEarningDelegate.findMany.mockResolvedValue([]);
    referralEarningDelegate.count.mockResolvedValue(0);

    await GET(makeGetQuery("limit=200"));
    expect(referralEarningDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
      }),
    );
  });

  it("returns 500 on database error", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    referralEarningDelegate.findMany.mockRejectedValue(new Error("DB error"));

    const res = await GET(makeGetQuery());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch referral earnings");
  });
});