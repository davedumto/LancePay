import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { resolveBadgeActor } from "@/app/api/_lib/badge-auth";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userBadge: { findMany: vi.fn() },
    userBadgeRevocation: { findMany: vi.fn() },
  },
}));

vi.mock("@/app/api/_lib/badge-auth", () => ({
  resolveBadgeActor: vi.fn(),
  isAdmin: vi.fn((actor) => actor.kind === "user" && actor.role === "admin"),
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const mockTargetUser = {
  id: "user-target-1",
  name: "Alice Freelancer",
  publicVisibility: true,
};

const mockBadgeDef = {
  id: "badge-top-rated",
  name: "Top Rated Freelancer",
  description: "Completed 50+ invoices with high rating",
  imageUrl: "https://example.com/badge.png",
  stellarAssetCode: "TOPRATED",
  criteriaJson: { minCompletedInvoices: 50 },
  isActive: true,
};

function makeRequest(url = "http://localhost/api/users/user-target-1/badges", token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest(url, {
    method: "GET",
    headers,
  });
}

describe("GET /api/users/[id]/badges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveBadgeActor).mockResolvedValue({
      actor: { kind: "user", id: "other-user", role: "freelancer" },
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockTargetUser as any);
    vi.mocked(prisma.userBadge.findMany).mockResolvedValue([
      {
        id: "ub-1",
        userId: "user-target-1",
        badgeId: "badge-top-rated",
        issuedAt: new Date("2026-01-01"),
        stellarTxHash: "tx-hash-badge",
        badge: mockBadgeDef,
      },
    ] as any);
    vi.mocked(prisma.userBadgeRevocation.findMany).mockResolvedValue([]);
  });

  it("returns 404 when target user is not found", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    const res = await GET(makeRequest(), { params: Promise.resolve({ id: "missing-user" }) });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("User not found");
  });

  it("returns user badges with joined BadgeDefinition metadata on public profile", async () => {
    const res = await GET(makeRequest(), { params: Promise.resolve({ id: "user-target-1" }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.id).toBe("user-target-1");
    expect(json.badges).toHaveLength(1);
    expect(json.badges[0].badge.name).toBe("Top Rated Freelancer");
    expect(json.badges[0].badge.stellarAssetCode).toBe("TOPRATED");
    expect(json.badges[0].status).toBe("active");
  });

  it("rejects public view with 403 when user has opted out of public visibility", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...mockTargetUser,
      publicVisibility: false,
    } as any);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: "user-target-1" }) });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toContain("private");
  });

  it("allows user to view their own badges even if publicVisibility is false", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...mockTargetUser,
      publicVisibility: false,
    } as any);
    vi.mocked(resolveBadgeActor).mockResolvedValue({
      actor: { kind: "user", id: "user-target-1", role: "freelancer" },
    });

    const res = await GET(makeRequest("http://localhost/api/users/user-target-1/badges", "self-token"), {
      params: Promise.resolve({ id: "user-target-1" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.badges).toHaveLength(1);
  });

  it("allows admin to view badges even if publicVisibility is false", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...mockTargetUser,
      publicVisibility: false,
    } as any);
    vi.mocked(resolveBadgeActor).mockResolvedValue({
      actor: { kind: "user", id: "admin-user", role: "admin" },
    });

    const res = await GET(makeRequest("http://localhost/api/users/user-target-1/badges", "admin-token"), {
      params: Promise.resolve({ id: "user-target-1" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.badges).toHaveLength(1);
  });

  it("includes revocation details when includeRevoked=true query parameter is provided", async () => {
    vi.mocked(prisma.userBadgeRevocation.findMany).mockResolvedValue([
      {
        id: "rev-1",
        userBadgeId: "ub-old",
        userId: "user-target-1",
        badgeId: "badge-top-rated",
        issuedAt: new Date("2025-01-01"),
        revokedAt: new Date("2025-06-01"),
        trigger: "criteria_no_longer_met",
        reason: "Invoice volume dropped below threshold",
        stellarTxHash: "tx-rev-hash",
        badge: mockBadgeDef,
      },
    ] as any);

    const res = await GET(
      makeRequest("http://localhost/api/users/user-target-1/badges?includeRevoked=true"),
      { params: Promise.resolve({ id: "user-target-1" }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.revokedBadges).toHaveLength(1);
    expect(json.revokedBadges[0].trigger).toBe("criteria_no_longer_met");
    expect(json.revokedBadges[0].reason).toContain("dropped below threshold");
  });
});
