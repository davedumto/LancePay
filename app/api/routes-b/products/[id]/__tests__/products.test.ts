import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ verifyAuthToken: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    product: { findFirst: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { verifyAuthToken } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { PATCH } from "../route";

const mockedVerify = vi.mocked(verifyAuthToken);
const userDelegate = prisma.user as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
};
const productDelegate = prisma.product as unknown as {
  findFirst: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

const BASE_URL = "http://localhost/api/routes-b/products/prod-1";

function makePatch(body: unknown, authHeader: string | null = "Bearer token") {
  return new NextRequest(BASE_URL, {
    method: "PATCH",
    headers: authHeader
      ? { authorization: authHeader, "content-type": "application/json" }
      : { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createParams(id: string = "prod-1") {
  return Promise.resolve({ id });
}

describe("PATCH /api/routes-b/products/[id]", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 401 when unauthenticated", async () => {
    mockedVerify.mockResolvedValue(null as never);
    const res = await PATCH(makePatch({}, null), { params: createParams() });
    expect(res.status).toBe(401);
  });

  it("returns 404 when user not found", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue(null);
    const res = await PATCH(makePatch({ name: "Updated" }), {
      params: createParams(),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when id is missing", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    const res = await PATCH(makePatch({ name: "Updated" }), {
      params: createParams(""),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when product not found", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findFirst.mockResolvedValue(null);
    const res = await PATCH(makePatch({ name: "Updated" }), {
      params: createParams(),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when no fields to update", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findFirst.mockResolvedValue({
      id: "prod-1",
      userId: "user-1",
    });
    const res = await PATCH(makePatch({}), { params: createParams() });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("No fields to update");
  });

  it("returns 400 when name is empty", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findFirst.mockResolvedValue({
      id: "prod-1",
      userId: "user-1",
    });
    const res = await PATCH(makePatch({ name: "" }), {
      params: createParams(),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when name exceeds 255 characters", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findFirst.mockResolvedValue({
      id: "prod-1",
      userId: "user-1",
    });
    const res = await PATCH(makePatch({ name: "x".repeat(256) }), {
      params: createParams(),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when description is not a string", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findFirst.mockResolvedValue({
      id: "prod-1",
      userId: "user-1",
    });
    const res = await PATCH(makePatch({ description: 123 }), {
      params: createParams(),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when priceUsdc is negative", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findFirst.mockResolvedValue({
      id: "prod-1",
      userId: "user-1",
    });
    const res = await PATCH(makePatch({ priceUsdc: -50 }), {
      params: createParams(),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when unit exceeds 50 characters", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findFirst.mockResolvedValue({
      id: "prod-1",
      userId: "user-1",
    });
    const res = await PATCH(makePatch({ unit: "x".repeat(51) }), {
      params: createParams(),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when isActive is not a boolean", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findFirst.mockResolvedValue({
      id: "prod-1",
      userId: "user-1",
    });
    const res = await PATCH(makePatch({ isActive: "true" }), {
      params: createParams(),
    });
    expect(res.status).toBe(400);
  });

  it("updates only the name field", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findFirst.mockResolvedValue({
      id: "prod-1",
      userId: "user-1",
    });
    productDelegate.update.mockResolvedValue({
      id: "prod-1",
      name: "New Name",
      description: "Old description",
      priceUsdc: 100,
      unit: "hour",
      isActive: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-15T00:00:00Z"),
    });

    const res = await PATCH(makePatch({ name: "New Name" }), {
      params: createParams(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.product.name).toBe("New Name");
    expect(productDelegate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "New Name" }),
      }),
    );
  });

  it("updates only the priceUsdc field", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findFirst.mockResolvedValue({
      id: "prod-1",
      userId: "user-1",
    });
    productDelegate.update.mockResolvedValue({
      id: "prod-1",
      name: "Consulting",
      description: null,
      priceUsdc: 250.5,
      unit: "hour",
      isActive: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-15T00:00:00Z"),
    });

    const res = await PATCH(makePatch({ priceUsdc: 250.5 }), {
      params: createParams(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.product.priceUsdc).toBe("250.5");
  });

  it("updates description to null", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findFirst.mockResolvedValue({
      id: "prod-1",
      userId: "user-1",
    });
    productDelegate.update.mockResolvedValue({
      id: "prod-1",
      name: "Consulting",
      description: null,
      priceUsdc: 100,
      unit: "hour",
      isActive: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-15T00:00:00Z"),
    });

    const res = await PATCH(makePatch({ description: null }), {
      params: createParams(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.product.description).toBeNull();
  });

  it("updates isActive to false", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findFirst.mockResolvedValue({
      id: "prod-1",
      userId: "user-1",
    });
    productDelegate.update.mockResolvedValue({
      id: "prod-1",
      name: "Consulting",
      description: null,
      priceUsdc: 100,
      unit: "hour",
      isActive: false,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-15T00:00:00Z"),
    });

    const res = await PATCH(makePatch({ isActive: false }), {
      params: createParams(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.product.isActive).toBe(false);
  });

  it("updates multiple fields at once", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findFirst.mockResolvedValue({
      id: "prod-1",
      userId: "user-1",
    });
    productDelegate.update.mockResolvedValue({
      id: "prod-1",
      name: "Design Services",
      description: "UI/UX design",
      priceUsdc: 150,
      unit: "day",
      isActive: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-15T00:00:00Z"),
    });

    const res = await PATCH(
      makePatch({
        name: "Design Services",
        description: "UI/UX design",
        priceUsdc: 150,
        unit: "day",
      }),
      { params: createParams() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.product.name).toBe("Design Services");
    expect(body.product.description).toBe("UI/UX design");
    expect(body.product.priceUsdc).toBe("150");
    expect(body.product.unit).toBe("day");
  });

  it("ensures product ownership is checked", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findFirst.mockResolvedValue(null);

    await PATCH(makePatch({ name: "Updated" }), { params: createParams() });

    expect(productDelegate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          id: "prod-1",
        }),
      }),
    );
  });

  it("trims whitespace from name and description", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findFirst.mockResolvedValue({
      id: "prod-1",
      userId: "user-1",
    });
    productDelegate.update.mockResolvedValue({
      id: "prod-1",
      name: "Trimmed Name",
      description: "Trimmed description",
      priceUsdc: 100,
      unit: "hour",
      isActive: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-15T00:00:00Z"),
    });

    await PATCH(
      makePatch({
        name: "  Trimmed Name  ",
        description: "  Trimmed description  ",
      }),
      { params: createParams() },
    );

    expect(productDelegate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Trimmed Name",
          description: "Trimmed description",
        }),
      }),
    );
  });

  it("returns 500 on database error", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockRejectedValue(
      new Error("DB connection failed"),
    );

    const res = await PATCH(makePatch({ name: "Updated" }), {
      params: createParams(),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to update product");
  });
});
