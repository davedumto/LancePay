import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    fxRateSnapshot: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({
  verifyAuthToken: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const mockAdminUser = { id: "admin-1", role: "admin" };
const mockFinanceUser = { id: "fin-1", role: "finance" };
const mockFreelancerUser = { id: "free-1", role: "freelancer" };

function makeRequest(url = "http://localhost/api/fx-rate-snapshots/staleness-check"): NextRequest {
  return new NextRequest(url, {
    method: "GET",
    headers: { authorization: "Bearer valid-token" },
  });
}

describe("GET /api/fx-rate-snapshots/staleness-check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: "privy-admin" } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockAdminUser as any);
  });

  it("returns 401 when Authorization header is missing or invalid", async () => {
    const unauthReq = new NextRequest("http://localhost/api/fx-rate-snapshots/staleness-check", {
      method: "GET",
    });
    const res = await GET(unauthReq);
    expect(res.status).toBe(401);
  });

  it("returns 401 when token verification fails", async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns 403 when user does not have admin or finance role", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockFreelancerUser as any);
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toContain("Forbidden");
  });

  it("allows access for finance role", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockFinanceUser as any);
    vi.mocked(prisma.fxRateSnapshot.findMany).mockResolvedValue([]);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.flaggedCount).toBe(0);
  });

  it("flags a pair as stale when latest capturedAt exceeds max age", async () => {
    const now = new Date();
    const staleDate = new Date(now.getTime() - 36 * 60 * 60 * 1000); // 36 hours ago

    vi.mocked(prisma.fxRateSnapshot.findMany).mockResolvedValue([
      {
        id: "snap-1",
        fromCurrency: "USD",
        toCurrency: "NGN",
        rate: "1500.00" as any,
        source: "exchangerate-api",
        capturedAt: staleDate,
        createdAt: staleDate,
      },
    ] as any);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.flaggedCount).toBe(1);
    expect(json.flaggedPairs[0].fromCurrency).toBe("USD");
    expect(json.flaggedPairs[0].toCurrency).toBe("NGN");
    expect(json.flaggedPairs[0].isStale).toBe(true);
    expect(json.flaggedPairs[0].isDivergent).toBe(false);
  });

  it("flags a pair as divergent when latest rate moves beyond configured percentage from prior snapshot of same source", async () => {
    const now = new Date();
    const latestDate = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1 hour ago
    const priorDate = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago

    vi.mocked(prisma.fxRateSnapshot.findMany).mockResolvedValue([
      {
        id: "snap-latest",
        fromCurrency: "EUR",
        toCurrency: "USD",
        rate: "1.20" as any, // 20% move from 1.00
        source: "exchangerate-api",
        capturedAt: latestDate,
        createdAt: latestDate,
      },
      {
        id: "snap-prior",
        fromCurrency: "EUR",
        toCurrency: "USD",
        rate: "1.00" as any,
        source: "exchangerate-api",
        capturedAt: priorDate,
        createdAt: priorDate,
      },
    ] as any);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.flaggedCount).toBe(1);
    expect(json.flaggedPairs[0].fromCurrency).toBe("EUR");
    expect(json.flaggedPairs[0].toCurrency).toBe("USD");
    expect(json.flaggedPairs[0].isStale).toBe(false);
    expect(json.flaggedPairs[0].isDivergent).toBe(true);
    expect(json.flaggedPairs[0].divergencePercent).toBe(20);
  });

  it("does not flag when rate is fresh and divergence is within threshold", async () => {
    const now = new Date();
    const latestDate = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1 hour ago
    const priorDate = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago

    vi.mocked(prisma.fxRateSnapshot.findMany).mockResolvedValue([
      {
        id: "snap-latest",
        fromCurrency: "GBP",
        toCurrency: "USD",
        rate: "1.26" as any, // 0.8% move from 1.25
        source: "exchangerate-api",
        capturedAt: latestDate,
        createdAt: latestDate,
      },
      {
        id: "snap-prior",
        fromCurrency: "GBP",
        toCurrency: "USD",
        rate: "1.25" as any,
        source: "exchangerate-api",
        capturedAt: priorDate,
        createdAt: priorDate,
      },
    ] as any);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.flaggedCount).toBe(0);
    expect(json.flaggedPairs).toHaveLength(0);
  });

  it("supports custom query parameters maxAgeHours and maxDivergencePercent", async () => {
    const now = new Date();
    const captured = new Date(now.getTime() - 5 * 60 * 60 * 1000); // 5 hours ago

    vi.mocked(prisma.fxRateSnapshot.findMany).mockResolvedValue([
      {
        id: "snap-1",
        fromCurrency: "USD",
        toCurrency: "KES",
        rate: "130.00" as any,
        source: "exchangerate-api",
        capturedAt: captured,
        createdAt: captured,
      },
    ] as any);

    // Stale with maxAgeHours=4
    const res = await GET(
      makeRequest("http://localhost/api/fx-rate-snapshots/staleness-check?maxAgeHours=4"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.flaggedCount).toBe(1);
    expect(json.flaggedPairs[0].isStale).toBe(true);
  });

  it("rejects invalid query parameters with 400", async () => {
    const res = await GET(
      makeRequest("http://localhost/api/fx-rate-snapshots/staleness-check?maxAgeHours=invalid"),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Invalid maxAgeHours");
  });
});
