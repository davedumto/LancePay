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
import { DELETE } from "../route";

const mockedVerify = vi.mocked(verifyAuthToken);
const userDelegate = prisma.user as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
};
const productDelegate = prisma.product as unknown as {
  findFirst: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

const BASE_URL = "http://localhost/api/routes-b/products/prod-1";

function makeDelete(authHeader: string | null = "Bearer token") {
  return new NextRequest(BASE_URL, {
    method: "DELETE",
    headers: authHeader
      ? { authorization: authHeader }
      : {},
  });
}

function createParams(id: string = "prod-1") {
  return Promise.resolve({ id });
}

describe("DELETE /api/routes-b/products/[id]", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 401 when unauthenticated", async () => {
    mockedVerify.mockResolvedValue(null as never);
    const res = await DELETE(makeDelete(null), { params: createParams() });
    expect(res.status).toBe(401);
  });

  it("returns 404 when user not found", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue(null);
    const res = await DELETE(makeDelete(), { params: createParams() });
    expect(res.status).toBe(404);
  });

  it("returns 400 when id is missing", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    const res = await DELETE(makeDelete(), { params: createParams("") });
    expect(res.status).toBe(400);
  });

  it("returns 404 when product not found", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findFirst.mockResolvedValue(null);
    const res = await DELETE(makeDelete(), { params: createParams() });
    expect(res.status).toBe(404);
  });

  it("soft-deletes the product and returns 204", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findFirst.mockResolvedValue({ id: "prod-1", userId: "user-1" });
    productDelegate.update.mockResolvedValue({ id: "prod-1" });

    const res = await DELETE(makeDelete(), { params: createParams() });
    expect(res.status).toBe(204);
    expect(productDelegate.update).toHaveBeenCalledWith({
      where: { id: "prod-1" },
      data: { isActive: false },
      select: { id: true },
    });
  });

  it("enforces ownership: only deletes own product", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    productDelegate.findFirst.mockResolvedValue(null);

    const res = await DELETE(makeDelete(), { params: createParams("prod-1") });
    expect(res.status).toBe(404);
    expect(productDelegate.update).not.toHaveBeenCalled();
  });

  it("returns 500 on database error", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockRejectedValue(new Error("DB connection failed"));

    const res = await DELETE(makeDelete(), { params: createParams() });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to delete product");
  });
});