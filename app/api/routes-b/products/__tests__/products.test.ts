import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ verifyAuthToken: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    product: { findMany: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { verifyAuthToken } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { GET, POST } from "../route";

const mockedVerify = vi.mocked(verifyAuthToken);
const userDelegate = prisma.user as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
};
const productDelegate = prisma.product as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};

const BASE_URL = "http://localhost/api/routes-b/products";

function makeGet(search?: string, authHeader: string | null = "Bearer token") {
  const url = search ? `${BASE_URL}?${search}` : BASE_URL;
  return new NextRequest(url, {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

function makePost(body: unknown, authHeader: string | null = "Bearer token") {
  return new NextRequest(BASE_URL, {
    method: "POST",
    headers: authHeader
      ? { authorization: authHeader, "content-type": "application/json" }
      : { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/routes-b/products", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 401 when unauthenticated", async () => {
    mockedVerify.mockResolvedValue(null as never);
    const res = await GET(makeGet(undefined, null));
    expect(res.status).toBe(401);
  });

  it("returns an empty list when the user has no products", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findMany.mockResolvedValue([]);
    const res = await GET(makeGet());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.products).toEqual([]);
  });

  it("returns 400 for an invalid active filter", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    const res = await GET(makeGet("active=maybe"));
    expect(res.status).toBe(400);
  });

  it("filters by isActive when active=true is provided", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findMany.mockResolvedValue([]);
    await GET(makeGet("active=true"));
    expect(productDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: true }),
      }),
    );
  });

  it("filters by isActive=false when active=false is provided", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findMany.mockResolvedValue([]);
    await GET(makeGet("active=false"));
    expect(productDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: false }),
      }),
    );
  });

  it("returns the user products with nullable fields normalised", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findMany.mockResolvedValue([
      {
        id: "prod-1",
        name: "Consulting",
        description: null,
        priceUsdc: 100.5,
        unit: "hour",
        isActive: true,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    const res = await GET(makeGet());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.products[0]).toMatchObject({
      id: "prod-1",
      name: "Consulting",
      description: null,
      priceUsdc: "100.5",
      unit: "hour",
      isActive: true,
    });
  });
});

describe("POST /api/routes-b/products", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 401 when unauthenticated", async () => {
    mockedVerify.mockResolvedValue(null as never);
    const res = await POST(makePost({ name: "Test" }, null));
    expect(res.status).toBe(401);
  });

  it("returns 400 when name is missing", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    const res = await POST(makePost({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 when name exceeds 255 characters", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    const res = await POST(makePost({ name: "x".repeat(256), priceUsdc: 10 }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when priceUsdc is missing", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    const res = await POST(makePost({ name: "Test Product" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when priceUsdc is negative", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    const res = await POST(makePost({ name: "Test Product", priceUsdc: -10 }));
    expect(res.status).toBe(400);
  });

  it("creates a product with all fields and returns 201", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.create.mockResolvedValue({
      id: "prod-new",
      name: "Web Development",
      description: "Full-stack development services",
      priceUsdc: 150.75,
      unit: "hour",
      isActive: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const res = await POST(
      makePost({
        name: "Web Development",
        description: "Full-stack development services",
        priceUsdc: 150.75,
        unit: "hour",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.product).toMatchObject({
      id: "prod-new",
      name: "Web Development",
      description: "Full-stack development services",
      priceUsdc: "150.75",
      unit: "hour",
      isActive: true,
    });
    expect(productDelegate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          name: "Web Development",
          priceUsdc: 150.75,
          unit: "hour",
          isActive: true,
        }),
      }),
    );
  });

  it("creates a product with minimal fields (name and priceUsdc only)", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.create.mockResolvedValue({
      id: "prod-2",
      name: "Design",
      description: null,
      priceUsdc: 50,
      unit: "item",
      isActive: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const res = await POST(makePost({ name: "Design", priceUsdc: 50 }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.product.unit).toBe("item");
  });

  it("defaults unit to item when not provided", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.create.mockResolvedValue({
      id: "prod-3",
      name: "Service",
      description: null,
      priceUsdc: 100,
      unit: "item",
      isActive: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await POST(makePost({ name: "Service", priceUsdc: 100 }));
    expect(productDelegate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ unit: "item" }),
      }),
    );
  });
});
