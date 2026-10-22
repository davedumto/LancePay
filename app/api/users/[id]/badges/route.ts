import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { resolveBadgeActor, isAdmin } from "@/app/api/_lib/badge-auth";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id: targetUserId } = await context.params;
    if (!targetUserId) {
      return NextResponse.json({ error: "User ID is required" }, { status: 400 });
    }

    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        name: true,
        publicVisibility: true,
      },
    });

    if (!targetUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Check caller authentication
    const authHeader = request.headers.get("authorization");
    let callerActor: { kind: "system" } | { kind: "user"; id: string; role: string } | null = null;

    if (authHeader) {
      const auth = await resolveBadgeActor(request);
      if (!("response" in auth)) {
        callerActor = auth.actor;
      }
    }

    const isSelf = callerActor?.kind === "user" && callerActor.id === targetUser.id;
    const isCallerAdmin = callerActor ? isAdmin(callerActor) : false;
    const isSystem = callerActor?.kind === "system";

    // Public profile view rule:
    // If not self, not admin, and not system, user must have publicVisibility === true
    if (!isSelf && !isCallerAdmin && !isSystem) {
      if (!targetUser.publicVisibility) {
        return NextResponse.json(
          { error: "User profile badges are private" },
          { status: 403 },
        );
      }
    }

    const { searchParams } = new URL(request.url);
    const includeRevoked = searchParams.get("includeRevoked") === "true";

    // Fetch earned badges with BadgeDefinition metadata
    const userBadges = await prisma.userBadge.findMany({
      where: { userId: targetUserId },
      include: {
        badge: true,
      },
      orderBy: { issuedAt: "desc" },
    });

    // Fetch revocations for this user to check revocation context
    const revocations = await prisma.userBadgeRevocation.findMany({
      where: { userId: targetUserId },
      include: {
        badge: true,
      },
      orderBy: { revokedAt: "desc" },
    });

    // Build map of revocations by badgeId
    const revocationsByBadgeId = new Map<string, typeof revocations>();
    for (const rev of revocations) {
      const list = revocationsByBadgeId.get(rev.badgeId) ?? [];
      list.push(rev);
      revocationsByBadgeId.set(rev.badgeId, list);
    }

    const activeBadges: any[] = [];
    for (const ub of userBadges) {
      const badgeRevocations = revocationsByBadgeId.get(ub.badgeId) ?? [];
      // A badge currently in UserBadge table is active, unless there's revocation context
      activeBadges.push({
        id: ub.id,
        badgeId: ub.badgeId,
        issuedAt: ub.issuedAt,
        stellarTxHash: ub.stellarTxHash,
        status: "active",
        badge: {
          id: ub.badge.id,
          name: ub.badge.name,
          description: ub.badge.description,
          imageUrl: ub.badge.imageUrl,
          stellarAssetCode: ub.badge.stellarAssetCode,
          criteriaJson: ub.badge.criteriaJson,
          isActive: ub.badge.isActive,
        },
        revocation: badgeRevocations[0] ?? null,
      });
    }

    const revokedBadges: any[] = [];
    if (includeRevoked) {
      for (const rev of revocations) {
        revokedBadges.push({
          id: rev.id,
          userBadgeId: rev.userBadgeId,
          badgeId: rev.badgeId,
          issuedAt: rev.issuedAt,
          revokedAt: rev.revokedAt,
          trigger: rev.trigger,
          reason: rev.reason,
          status: "revoked",
          stellarTxHash: rev.stellarTxHash,
          badge: {
            id: rev.badge.id,
            name: rev.badge.name,
            description: rev.badge.description,
            imageUrl: rev.badge.imageUrl,
            stellarAssetCode: rev.badge.stellarAssetCode,
            criteriaJson: rev.badge.criteriaJson,
            isActive: rev.badge.isActive,
          },
        });
      }
    }

    return NextResponse.json({
      user: {
        id: targetUser.id,
        name: targetUser.name,
        publicVisibility: targetUser.publicVisibility,
      },
      badges: activeBadges,
      ...(includeRevoked ? { revokedBadges } : {}),
      totalActiveBadges: activeBadges.length,
    });
  } catch (error: any) {
    logger.error({ err: error }, "GET /api/users/[id]/badges error");
    return NextResponse.json({ error: "Failed to fetch user badges" }, { status: 500 });
  }
}
