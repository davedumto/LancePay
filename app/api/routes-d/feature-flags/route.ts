import { NextRequest, NextResponse } from "next/server";
import { verifyAuthToken } from "@/lib/auth";
import { logger } from "@/lib/logger";

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers
    .get("authorization")
    ?.replace("Bearer ", "");
  if (!authToken) return null;
  const claims = await verifyAuthToken(authToken);
  if (!claims) return null;
  return { id: claims.userId };
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // In a real implementation, this would fetch feature flags from the database
    // or a feature flag service. For now, return a structured response.
    const featureFlags = {
      referralProgram: { enabled: true, description: "Referral program with earnings" },
      multiCurrency: { enabled: true, description: "Multi-currency invoice support" },
      batchInvoicing: { enabled: false, description: "Batch invoice generation" },
      advancedAnalytics: { enabled: true, description: "Advanced reporting and analytics" },
    };

    return NextResponse.json({
      flags: featureFlags,
      userId: user.id,
    });
  } catch (error) {
    logger.error({ err: error }, "GET /api/routes-d/feature-flags error");
    return NextResponse.json(
      { error: "Failed to fetch feature flags" },
      { status: 500 },
    );
  }
}