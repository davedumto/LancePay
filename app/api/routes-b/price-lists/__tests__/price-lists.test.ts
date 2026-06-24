import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ verifyAuthToken: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    priceList: { findMany: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { verifyAuthToken } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { GET, POST } from "../route";

const mockedVerify = vi.mocked(verifyAuthToken);
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> };
const plDelegate = prisma.priceList as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};

const BASE_URL = "http://localhost/api/routes-b/price-lists";

function makeGet(search?: string, auth: string | null = "Bearer tok") {
  const url = search ? `${BASE_URL}?${search}` : BASE_URL;
  return new NextRequest(url, { headers: auth ? { authorization: auth } : {} });
}

function makePost(body: unknown, auth: string | null = "Bearer tok") {
  return new NextRequest(BASE_URL, {
    method: "POST",
    headers: auth
      ? { authorization: auth, "content-type": "application/json" }
      : { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const samplePL = {
  id: "pl-1",
  name: "Standard",
  description: "Default price list",
  currency: "USD",
  isDefault: true,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("GET /api/routes-b/price-lists", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 401 when unauthenticated", async () => {
    mockedVerify.mockResolvedValue(null as never);
    const res = await GET(makeGet(undefined, null));
    expect(res.status).toBe(401);
  });

  it("returns empty list when user has no price lists", async () => {
    mockedVerify.mockResolvedValue({ userId: "p1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "u1" });
    plDelegate.findMany.mockResolvedValue([]);
    const res = await GET(makeGet());
    expect(res.status).toBe(200);
    expect((await res.json()).priceLists).toEqual([]);
  });

  it("returns price lists with pagination defaults", async () => {
    mockedVerify.mockResolvedValue({ userId: "p1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "u1" });
    plDelegate.findMany.mockResolvedValue([samplePL]);
    const res = await GET(makeGet());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.priceLists[0].id).toBe("pl-1");
    expect(body.page).toBe(1);
    expect(body.limit).toBe(20);
  });

  it("passes ownership filter to prisma", async () => {
    mockedVerify.mockResolvedValue({ userId: "p1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "u1" });
    plDelegate.findMany.mockResolvedValue([]);
    await GET(makeGet());
    expect(plDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u1" } }),
    );
  });

  it("respects custom page and limit query params", async () => {
    mockedVerify.mockResolvedValue({ userId: "p1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "u1" });
    plDelegate.findMany.mockResolvedValue([]);
    await GET(makeGet("page=2&limit=5"));
    expect(plDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 5, take: 5 }),
    );
  });
});

describe("POST /api/routes-b/price-lists", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 401 when unauthenticated", async () => {
    mockedVerify.mockResolvedValue(null as never);
    const res = await POST(makePost({ name: "Test" }, null));
    expect(res.status).toBe(401);
  });

  it("returns 400 when name is missing", async () => {
    mockedVerify.mockResolvedValue({ userId: "p1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "u1" });
    const res = await POST(makePost({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 when name exceeds 255 characters", async () => {
    mockedVerify.mockResolvedValue({ userId: "p1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "u1" });
    const res = await POST(makePost({ name: "x".repeat(256) }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid currency code", async () => {
    mockedVerify.mockResolvedValue({ userId: "p1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "u1" });
    const res = await POST(makePost({ name: "List", currency: "USDC" }));
    expect(res.status).toBe(400);
  });

  it("creates a price list and returns 201", async () => {
    mockedVerify.mockResolvedValue({ userId: "p1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "u1" });
    plDelegate.create.mockResolvedValue(samplePL);
    const res = await POST(makePost({ name: "Standard", description: "Default", currency: "USD", isDefault: true }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.priceList.id).toBe("pl-1");
    expect(body.priceList.currency).toBe("USD");
  });

  it("defaults currency to USD when omitted", async () => {
    mockedVerify.mockResolvedValue({ userId: "p1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "u1" });
    plDelegate.create.mockResolvedValue({ ...samplePL, currency: "USD" });
    await POST(makePost({ name: "List" }));
    expect(plDelegate.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ currency: "USD" }) }),
    );
  });

  it("normalises currency to uppercase", async () => {
    mockedVerify.mockResolvedValue({ userId: "p1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "u1" });
    plDelegate.create.mockResolvedValue({ ...samplePL, currency: "EUR" });
    await POST(makePost({ name: "Euro List", currency: "eur" }));
    expect(plDelegate.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ currency: "EUR" }) }),
    );
  });

  it("returns 400 for invalid JSON body", async () => {
    mockedVerify.mockResolvedValue({ userId: "p1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "u1" });
    const req = new NextRequest(BASE_URL, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
