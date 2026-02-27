import { NextRequest, NextResponse } from "next/server";
import { logger } from '@/lib/logger'
import {
  fetchBadgeMetadata,
  isBadgeMetadataLocked,
} from "@/lib/sep68-metadata";

/**
 * GET /api/routes-d/badges/metadata
 * Fetch SEP-68 metadata for a badge
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const issuerAddress = searchParams.get("issuer");
    const assetCode = searchParams.get("code");

    if (!issuerAddress || !assetCode) {
      return NextResponse.json(
        { error: "Issuer address and asset code required" },
        { status: 400 }
      );
    }

    const metadata = await fetchBadgeMetadata(issuerAddress, assetCode);
    const isLocked = await isBadgeMetadataLocked(issuerAddress, assetCode);

    if (!metadata) {
      return NextResponse.json(
        { error: "Metadata not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      metadata,
      isLocked,
    });
  } catch (error) {
    logger.error({ err: error }, "Error fetching badge metadata:");
    return NextResponse.json(
      { error: "Failed to fetch metadata" },
      { status: 500 }
    );
  }
}
