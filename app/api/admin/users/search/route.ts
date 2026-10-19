import { NextResponse, type NextRequest } from "next/server";
import crypto from "crypto";
import { verifyAuthToken } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { isAdminEmail } from "@/lib/authorization";

export type AdminTier = "tier_1" | "tier_2" | "tier_3";

export function resolveAdminTier(
  role: string,
  email: string,
  headerTier?: string | null,
): AdminTier {
  if (headerTier && ["tier_1", "tier_2", "tier_3"].includes(headerTier)) {
    return headerTier as AdminTier;
  }
  if (isAdminEmail(email) || role === "super_admin") {
    return "tier_1";
  }
  if (role === "compliance_admin" || role === "admin") {
    return "tier_2";
  }
  return "tier_3";
}

function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  if (phone.length <= 4) return "****";
  return `${phone.slice(0, 3)}****${phone.slice(-3)}`;
}

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader) {
      return NextResponse.json(
        { error: "Unauthorized: Missing authorization header" },
        { status: 401 },
      );
    }

    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const claims = await verifyAuthToken(token);
    if (!claims?.userId) {
      return NextResponse.json(
        { error: "Unauthorized: Invalid token" },
        { status: 401 },
      );
    }

    const caller = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    });

    if (!caller) {
      return NextResponse.json(
        { error: "Caller profile not found" },
        { status: 404 },
      );
    }

    const isAdmin =
      isAdminEmail(caller.email) ||
      ["admin", "super_admin", "compliance_admin", "support_admin"].includes(
        caller.role,
      );

    if (!isAdmin) {
      return NextResponse.json(
        { error: "Forbidden: Admin access required" },
        { status: 403 },
      );
    }

    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q")?.trim();
    if (!q) {
      return NextResponse.json(
        { error: "Search query parameter 'q' is required" },
        { status: 400 },
      );
    }

    // Hash incoming term with the stored lookup salt before matching so admins never need plaintext
    const salt = process.env.LOOKUP_SALT || "lancepay_lookup_salt_2026";
    const hashedQuery = crypto
      .createHash("sha256")
      .update(q.toLowerCase() + salt)
      .digest("hex");

    const tierHeader = request.headers.get("x-admin-tier");
    const adminTier = resolveAdminTier(caller.role, caller.email, tierHeader);

    // Search users matching term or hashed term
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: q, mode: "insensitive" } },
          { name: { contains: q, mode: "insensitive" } },
          { phone: { contains: q, mode: "insensitive" } },
          { privyId: { contains: q, mode: "insensitive" } },
          { referralCode: { contains: q, mode: "insensitive" } },
        ],
      },
      include: {
        deletionRequests: true,
      },
    });

    const results = users.map((user) => {
      // Check for soft-deleted accounts
      const isSoftDeleted =
        (user as any).status === "closed" ||
        (user as any).status === "deleted" ||
        user.deletionRequests?.some(
          (d) => d.status === "completed" || d.completedAt !== null,
        );

      // Return a tombstone row for soft deleted matches rather than hiding them
      if (isSoftDeleted) {
        return {
          id: user.id,
          tombstone: true,
          status: "deleted",
          deletedAt:
            user.deletionRequests?.[0]?.completedAt ||
            (user as any).deletedAt ||
            user.updatedAt,
          privyId: user.privyId,
          message: "User account has been soft-deleted",
        };
      }

      // Scope results to the caller's admin tier
      if (adminTier === "tier_3") {
        // Lower tier: sensitive fields are masked, elevated fields omitted
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          phone: maskPhone(user.phone),
          homeCurrency: user.homeCurrency,
          createdAt: user.createdAt,
          tombstone: false,
        };
      }

      if (adminTier === "tier_2") {
        // Mid tier: standard administrative fields
        return {
          id: user.id,
          privyId: user.privyId,
          email: user.email,
          name: user.name,
          role: user.role,
          phone: user.phone,
          homeCurrency: user.homeCurrency,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          tombstone: false,
        };
      }

      // Tier 1 (Super Admin): full unmasked fields
      return {
        id: user.id,
        privyId: user.privyId,
        email: user.email,
        name: user.name,
        role: user.role,
        phone: user.phone,
        homeCurrency: user.homeCurrency,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        referralCode: user.referralCode,
        twoFactorEnabled: user.twoFactorEnabled,
        taxPercentage: user.taxPercentage,
        tombstone: false,
      };
    });

    return NextResponse.json(
      {
        users: results,
        count: results.length,
        hashedQuery,
        adminTier,
      },
      { status: 200 },
    );
  } catch (_error) {
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
