import { NextRequest, NextResponse } from "next/server";
import { getCustomerStatus } from "@/lib/sep12-kyc";
import { logger } from '@/lib/logger'
import { getClientIp, kycStatusLimiter, buildRateLimitResponse } from "@/lib/rate-limit";

/**
 * GET /api/kyc/status
 * Get user's KYC verification status
 */
export async function GET(req: NextRequest) {
  try {
    const clientIp = getClientIp(req);
    const statusCheck = kycStatusLimiter.check(clientIp);
    if (!statusCheck.allowed) {
      console.warn("[rate-limit] KYC status limit exceeded", { ip: clientIp });
      return buildRateLimitResponse(statusCheck);
    }

    const stellarAddress = req.headers.get("x-stellar-address");
    const authToken = req.headers.get("x-sep10-token");

    if (!stellarAddress || !authToken) {
      return NextResponse.json(
        { error: "Stellar address and auth token required" },
        { status: 400 }
      );
    }

    const customerInfo = await getCustomerStatus(stellarAddress, authToken);

    return NextResponse.json({
      success: true,
      data: customerInfo,
    });
  } catch (error: any) {
    logger.error({ err: error }, "Error fetching KYC status:");
    return NextResponse.json(
      { error: error.message || "Failed to fetch KYC status" },
      { status: 500 }
    );
  }
}
