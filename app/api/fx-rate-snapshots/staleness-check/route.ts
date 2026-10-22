import { NextRequest, NextResponse } from "next/server";
import { verifyAuthToken } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

const ALLOWED_ROLES = new Set(["admin", "finance"]);

// Defaults:
// maxAgeHours: 24 (or configurable via query param)
// maxDivergencePercent: 5.0 (or configurable via query param, e.g. 5% = 0.05)
const DEFAULT_MAX_AGE_HOURS = 24;
const DEFAULT_MAX_DIVERGENCE_PERCENT = 5.0;

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const authToken = authHeader.replace("Bearer ", "");
    const claims = await verifyAuthToken(authToken);
    if (!claims) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const actor = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, role: true },
    });
    if (!actor) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    if (!ALLOWED_ROLES.has(actor.role)) {
      return NextResponse.json(
        { error: "Forbidden: admin or finance role required" },
        { status: 403 },
      );
    }

    const { searchParams } = new URL(request.url);
    const maxAgeHoursParam = searchParams.get("maxAgeHours");
    const maxDivergencePercentParam = searchParams.get("maxDivergencePercent");

    const maxAgeHours = maxAgeHoursParam ? parseFloat(maxAgeHoursParam) : DEFAULT_MAX_AGE_HOURS;
    const maxDivergencePercent = maxDivergencePercentParam
      ? parseFloat(maxDivergencePercentParam)
      : DEFAULT_MAX_DIVERGENCE_PERCENT;

    if (isNaN(maxAgeHours) || maxAgeHours <= 0) {
      return NextResponse.json({ error: "Invalid maxAgeHours parameter" }, { status: 400 });
    }
    if (isNaN(maxDivergencePercent) || maxDivergencePercent < 0) {
      return NextResponse.json(
        { error: "Invalid maxDivergencePercent parameter" },
        { status: 400 },
      );
    }

    const now = new Date();
    const stalenessThreshold = new Date(now.getTime() - maxAgeHours * 60 * 60 * 1000);

    // Fetch all snapshots ordered by capturedAt desc
    const snapshots = await prisma.fxRateSnapshot.findMany({
      orderBy: { capturedAt: "desc" },
    });

    // Group snapshots by pair: `${fromCurrency}:${toCurrency}`
    const pairsMap = new Map<string, typeof snapshots>();
    for (const snap of snapshots) {
      const key = `${snap.fromCurrency.toUpperCase()}:${snap.toCurrency.toUpperCase()}`;
      const group = pairsMap.get(key) ?? [];
      group.push(snap);
      pairsMap.set(key, group);
    }

    const flaggedPairs: Array<{
      fromCurrency: string;
      toCurrency: string;
      latestSnapshot: {
        id: string;
        rate: string;
        source: string;
        capturedAt: Date;
        ageHours: number;
      };
      priorSnapshot: {
        id: string;
        rate: string;
        source: string;
        capturedAt: Date;
      } | null;
      isStale: boolean;
      isDivergent: boolean;
      divergencePercent: number | null;
      reasons: string[];
    }> = [];

    for (const [pairKey, list] of pairsMap.entries()) {
      if (list.length === 0) continue;
      const latest = list[0];
      const [fromCurrency, toCurrency] = pairKey.split(":");

      const ageMs = now.getTime() - new Date(latest.capturedAt).getTime();
      const ageHours = Math.round((ageMs / (1000 * 60 * 60)) * 100) / 100;
      const isStale = new Date(latest.capturedAt) < stalenessThreshold;

      // Find immediately prior snapshot from the SAME source
      const prior = list.slice(1).find((s) => s.source === latest.source) ?? null;

      let isDivergent = false;
      let divergencePercent: number | null = null;

      if (prior) {
        const latestRate = Number(latest.rate);
        const priorRate = Number(prior.rate);
        if (priorRate > 0) {
          const move = (Math.abs(latestRate - priorRate) / priorRate) * 100;
          divergencePercent = Math.round(move * 100) / 100;
          if (divergencePercent > maxDivergencePercent) {
            isDivergent = true;
          }
        }
      }

      const reasons: string[] = [];
      if (isStale) {
        reasons.push(`Snapshot is ${ageHours}h old (exceeds max age of ${maxAgeHours}h)`);
      }
      if (isDivergent && divergencePercent !== null) {
        reasons.push(
          `Rate moved by ${divergencePercent}% from prior snapshot from source '${latest.source}' (exceeds threshold of ${maxDivergencePercent}%)`,
        );
      }

      if (isStale || isDivergent) {
        flaggedPairs.push({
          fromCurrency,
          toCurrency,
          latestSnapshot: {
            id: latest.id,
            rate: latest.rate.toString(),
            source: latest.source,
            capturedAt: latest.capturedAt,
            ageHours,
          },
          priorSnapshot: prior
            ? {
                id: prior.id,
                rate: prior.rate.toString(),
                source: prior.source,
                capturedAt: prior.capturedAt,
              }
            : null,
          isStale,
          isDivergent,
          divergencePercent,
          reasons,
        });
      }
    }

    return NextResponse.json({
      checkedAt: now.toISOString(),
      maxAgeHours,
      maxDivergencePercent,
      flaggedCount: flaggedPairs.length,
      flaggedPairs,
    });
  } catch (error: any) {
    logger.error({ err: error }, "GET /api/fx-rate-snapshots/staleness-check error");
    return NextResponse.json(
      { error: error?.message || "Failed to check fx rate staleness" },
      { status: 500 },
    );
  }
}
