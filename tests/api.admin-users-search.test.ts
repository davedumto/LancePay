import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const verifyAuthToken = vi.fn();
const userFindUnique = vi.fn();
const userFindMany = vi.fn();

vi.mock("@/lib/auth", () => ({
  verifyAuthToken: (...args: any[]) => verifyAuthToken(...args),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: (...args: any[]) => userFindUnique(...args),
      findMany: (...args: any[]) => userFindMany(...args),
    },
  },
}));

vi.mock("@/lib/authorization", () => ({
  isAdminEmail: (email: string) => email.includes("superadmin@lancepay.com"),
}));

const BASE_URL = "http://localhost/api/admin/users/search";

function makeRequest(
  queryParams: Record<string, string> = { q: "alice" },
  authHeader: string | null = "Bearer valid_admin_token",
  extraHeaders: Record<string, string> = {},
) {
  const url = new URL(BASE_URL);
  Object.entries(queryParams).forEach(([k, v]) =>
    url.searchParams.append(k, v),
  );

  const headers: Record<string, string> = { ...extraHeaders };
  if (authHeader) {
    headers.authorization = authHeader;
  }

  return new NextRequest(url.toString(), {
    method: "GET",
    headers,
  });
}

describe("GET /api/admin/users/search (#1574)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when authorization header is missing", async () => {
    const { GET } = await import("@/app/api/admin/users/search/route");
    const res = await GET(makeRequest({ q: "test" }, null));
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is not an admin", async () => {
    verifyAuthToken.mockResolvedValue({ userId: "privy_freelancer" });
    userFindUnique.mockResolvedValue({
      id: "user_freelancer",
      email: "freelancer@example.com",
      role: "freelancer",
    });

    const { GET } = await import("@/app/api/admin/users/search/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
  });

  it("returns 400 when search query q is missing or blank", async () => {
    verifyAuthToken.mockResolvedValue({ userId: "privy_admin" });
    userFindUnique.mockResolvedValue({
      id: "admin_1",
      email: "admin@lancepay.com",
      role: "admin",
    });

    const { GET } = await import("@/app/api/admin/users/search/route");
    const res = await GET(makeRequest({ q: "" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/parameter 'q' is required/i);
  });

  it("returns a tombstone row for soft deleted matches instead of hiding them", async () => {
    verifyAuthToken.mockResolvedValue({ userId: "privy_admin" });
    userFindUnique.mockResolvedValue({
      id: "admin_1",
      email: "admin@lancepay.com",
      role: "admin",
    });

    const activeUser = {
      id: "user_active",
      privyId: "privy_active",
      email: "alice@example.com",
      name: "Alice Active",
      phone: "+2348011112222",
      role: "freelancer",
      homeCurrency: "NGN",
      status: "active",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
      deletionRequests: [],
    };

    const softDeletedUser = {
      id: "user_deleted",
      privyId: "privy_deleted",
      email: "alice_old@example.com",
      name: "Alice Deleted",
      phone: "+2348033334444",
      role: "freelancer",
      homeCurrency: "NGN",
      status: "closed",
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date("2025-06-01"),
      deletionRequests: [
        { status: "completed", completedAt: new Date("2025-06-01") },
      ],
    };

    userFindMany.mockResolvedValue([activeUser, softDeletedUser]);

    const { GET } = await import("@/app/api/admin/users/search/route");
    const res = await GET(makeRequest({ q: "alice" }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.users).toHaveLength(2);

    const tombstone = body.users.find((u: any) => u.id === "user_deleted");
    expect(tombstone).toBeDefined();
    expect(tombstone.tombstone).toBe(true);
    expect(tombstone.status).toBe("deleted");
    expect(tombstone.deletedAt).toBeDefined();
    expect(tombstone.message).toMatch(/soft-deleted/i);
  });

  it("scopes results according to admin tier (lower tier masks phone and omits elevated fields)", async () => {
    verifyAuthToken.mockResolvedValue({ userId: "privy_support" });
    userFindUnique.mockResolvedValue({
      id: "admin_support",
      email: "support@lancepay.com",
      role: "support_admin",
    });

    const targetUser = {
      id: "user_1",
      privyId: "privy_user_1",
      email: "bob@example.com",
      name: "Bob Builder",
      phone: "+2348012345678",
      role: "freelancer",
      homeCurrency: "NGN",
      twoFactorEnabled: true,
      taxPercentage: 7.5,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
      deletionRequests: [],
    };
    userFindMany.mockResolvedValue([targetUser]);

    const { GET } = await import("@/app/api/admin/users/search/route");
    const res = await GET(makeRequest({ q: "bob" }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.adminTier).toBe("tier_3");
    const user = body.users[0];
    expect(user.phone).toContain("****");
    expect(user.twoFactorEnabled).toBeUndefined();
    expect(user.taxPercentage).toBeUndefined();
  });

  it("allows super_admin (tier_1) to view full unmasked fields", async () => {
    verifyAuthToken.mockResolvedValue({ userId: "privy_super" });
    userFindUnique.mockResolvedValue({
      id: "admin_super",
      email: "superadmin@lancepay.com",
      role: "super_admin",
    });

    const targetUser = {
      id: "user_1",
      privyId: "privy_user_1",
      email: "bob@example.com",
      name: "Bob Builder",
      phone: "+2348012345678",
      role: "freelancer",
      homeCurrency: "NGN",
      referralCode: "REF123",
      twoFactorEnabled: true,
      taxPercentage: 7.5,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
      deletionRequests: [],
    };
    userFindMany.mockResolvedValue([targetUser]);

    const { GET } = await import("@/app/api/admin/users/search/route");
    const res = await GET(makeRequest({ q: "bob" }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.adminTier).toBe("tier_1");
    const user = body.users[0];
    expect(user.phone).toBe("+2348012345678");
    expect(user.twoFactorEnabled).toBe(true);
    expect(user.taxPercentage).toBe(7.5);
    expect(user.referralCode).toBe("REF123");
  });
});
