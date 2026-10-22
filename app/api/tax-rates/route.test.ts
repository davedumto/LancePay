import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, POST } from "./route";
import { GET as getEffective } from "./effective/route";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    taxRate: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({
  verifyAuthToken: vi.fn(),
}));

const mockUser = { id: "user-1", email: "freelancer@example.com" };

function makePostRequest(
  body: object,
  token = "Bearer valid-token",
): NextRequest {
  return new NextRequest("http://localhost/api/tax-rates", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: token },
    body: JSON.stringify(body),
  });
}

function makeGetRequest(query = "", token = "Bearer valid-token"): NextRequest {
  return new NextRequest(`http://localhost/api/tax-rates${query}`, {
    method: "GET",
    headers: { authorization: token },
  });
}

function makeEffectiveRequest(
  query: string,
  token = "Bearer valid-token",
): NextRequest {
  return new NextRequest(`http://localhost/api/tax-rates/effective${query}`, {
    method: "GET",
    headers: { authorization: token },
  });
}

const validTaxRate = {
  id: "rate-1",
  name: "State Tax",
  description: "California state sales tax",
  jurisdiction: "US-CA",
  rate: 0.0725,
  effectiveFrom: new Date("2026-01-01"),
  effectiveTo: null,
  parentRateId: null,
  isDefault: false,
  createdAt: new Date("2026-01-01"),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: "privy-1" } as any);
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
});

describe("POST /api/tax-rates", () => {
  it("creates a tax rate with jurisdiction successfully", async () => {
    vi.mocked(prisma.taxRate.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.taxRate.create).mockResolvedValue(validTaxRate as any);

    const req = makePostRequest({
      name: "State Tax",
      description: "California state sales tax",
      jurisdiction: "US-CA",
      rate: 0.0725,
      effectiveFrom: "2026-01-01",
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.taxRate.jurisdiction).toBe("US-CA");
    expect(json.taxRate.rate).toBe(0.0725);
    expect(prisma.taxRate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          jurisdiction: "US-CA",
          userId: "user-1",
        }),
      }),
    );
  });

  it("rejects creation missing jurisdiction", async () => {
    const req = makePostRequest({
      name: "State Tax",
      rate: 0.0725,
      effectiveFrom: "2026-01-01",
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(prisma.taxRate.create).not.toHaveBeenCalled();
  });
});

describe("GET /api/tax-rates", () => {
  it("retrieves tax rates filtered by jurisdiction", async () => {
    vi.mocked(prisma.taxRate.findMany).mockResolvedValue([validTaxRate] as any);

    const req = makeGetRequest("?jurisdiction=US-CA");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.taxRates).toHaveLength(1);
    expect(json.taxRates[0].jurisdiction).toBe("US-CA");
    expect(prisma.taxRate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          jurisdiction: "US-CA",
        }),
      }),
    );
  });
});

describe("GET /api/tax-rates/effective", () => {
  it("looks up the effective tax rate for a jurisdiction as of a given date", async () => {
    vi.mocked(prisma.taxRate.findFirst).mockResolvedValue(validTaxRate as any);

    const req = makeEffectiveRequest("?jurisdiction=US-CA&date=2026-06-01");
    const res = await getEffective(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe("rate-1");
    expect(json.effectiveRate).toBeCloseTo(0.0725);
    expect(json.jurisdiction).toBe("US-CA");
  });
});
