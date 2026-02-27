import { NextRequest, NextResponse } from "next/server";
import {
  createProjectBadgeMetadata,
  createAchievementBadgeMetadata,
  uploadMetadataToIPFS,
  storeBadgeMetadataOnChain,
  lockBadgeMetadata,
} from "@/lib/sep68-metadata";
import { Keypair } from "@stellar/stellar-sdk";
import { logger } from '@/lib/logger'

/**
 * POST /api/routes-d/badges/issue
 * Issue a badge with SEP-68 metadata
 */
export async function POST(req: NextRequest) {
  try {
    const {
      badgeType,
      recipientAddress,
      projectId,
      projectName,
      completionDate,
      rating,
      category,
      achievementType,
      metricValue,
    } = await req.json();

    if (!badgeType || !recipientAddress) {
      return NextResponse.json(
        { error: "Badge type and recipient required" },
        { status: 400 }
      );
    }

    // Create metadata based on badge type
    let metadata;
    if (badgeType === "project") {
      metadata = createProjectBadgeMetadata(
        projectId,
        projectName,
        completionDate,
        rating,
        category
      );
    } else if (badgeType === "achievement") {
      metadata = createAchievementBadgeMetadata(
        achievementType,
        new Date().toISOString(),
        metricValue
      );
    } else {
      return NextResponse.json(
        { error: "Invalid badge type" },
        { status: 400 }
      );
    }

    // Upload metadata to IPFS
    const metadataUrl = await uploadMetadataToIPFS(metadata);

    // TODO: Get issuer keypair from secure storage
    // This is placeholder - in production use proper key management
    const issuerSecret = process.env.BADGE_ISSUER_SECRET;
    if (!issuerSecret) {
      return NextResponse.json(
        { error: "Badge issuer not configured" },
        { status: 500 }
      );
    }

    const issuerKeypair = Keypair.fromSecret(issuerSecret);

    // Generate asset code (e.g., BADGE_001)
    const assetCode = `BADGE_${Date.now().toString().slice(-6)}`;

    // Store metadata pointer on-chain
    const metadataTxHash = await storeBadgeMetadataOnChain(
      issuerKeypair,
      assetCode,
      metadataUrl
    );

    // Lock metadata to make it immutable
    const lockTxHash = await lockBadgeMetadata(issuerKeypair, assetCode);

    // TODO: Issue the actual soulbound token to recipient
    // (This would use the existing badge issuance logic)

    return NextResponse.json({
      success: true,
      assetCode,
      metadataUrl,
      metadataTxHash,
      lockTxHash,
      metadata,
    });
  } catch (error: any) {
    logger.error({ err: error }, "Error issuing badge:");
    return NextResponse.json(
      { error: error.message || "Failed to issue badge" },
      { status: 500 }
    );
  }
}
