import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ verifyAuthToken: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    depositAddress: { findUnique: vi.fn(), update: vi.fn() },
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
const depositAddressDelegate = prisma.depositAddress as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

const BASE_URL = "http://localhost/api/routes-d/deposits/addresses/addr-1";

function makeDelete(authHeader: string | null = "Bearer token") {
  return new NextRequest(BASE_URL, {
    method: "DELETE",
    headers: authHeader
      ? { authorization: authHeader }
      : {},
  });
}

function createParams(id: string = "addr-1") {
  return Promise.resolve({ id });
}

describe("DELETE /api/routes-d/deposits/addresses/[id]", () => {
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

  it("returns 404 when deposit address not found", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    depositAddressDelegate.findUnique.mockResolvedValue(null);
    const res = await DELETE(makeDelete(), { params: createParams() });
    expect(res.status).toBe(404);
  });

  it("returns 403 when address belongs to another user", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    depositAddressDelegate.findUnique.mockResolvedValue({
      id: "addr-1",
      userId: "other-user",
    });
    const res = await DELETE(makeDelete(), { params: createParams() });
    expect(res.status).toBe(403);
    expect(depositAddressDelegate.update).not.toHaveBeenCalled();
  });

  it("archives the deposit address and returns 204", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    depositAddressDelegate.findUnique.mockResolvedValue({
      id: "addr-1",
      userId: "user-1",
    });
    depositAddressDelegate.update.mockResolvedValue({ id: "addr-1" });

    const res = await DELETE(makeDelete(), { params: createParams() });
    expect(res.status).toBe(204);
    expect(depositAddressDelegate.update).toHaveBeenCalledWith({
      where: { id: "addr-1" },
      data: { status: "archived" },
      select: { id: true },
    });
  });

  it("returns 500 on database error", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockRejectedValue(new Error("DB connection failed"));

    const res = await DELETE(makeDelete(), { params: createParams() });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to remove deposit address");
  });
});