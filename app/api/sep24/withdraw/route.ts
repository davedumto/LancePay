/**
 * SEP-24 Withdrawal Initiation API
 * 
 * Handles the initiation of SEP-24 withdrawals.
 * Returns an interactive URL for the anchor's KYC/withdrawal flow.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyAuthToken } from '@/lib/auth';
import { initiateWithdrawal, getAnchorInfo } from '@/lib/stellar/sep24';
import { type AnchorId, ANCHOR_CONFIGS } from '@/lib/stellar/anchors';
import { isTokenExpired } from '@/lib/stellar/sep10';
import { Decimal } from '@prisma/client/runtime/library';
import { logger } from '@/lib/logger'

/**
 * GET /api/sep24/withdraw
 * 
 * Get anchor info and withdrawal limits
 * Query params: anchorId
 */
export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '');
  const claims = await verifyAuthToken(authToken || '');
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const anchorId = searchParams.get('anchorId') as AnchorId;

  if (!anchorId || !ANCHOR_CONFIGS[anchorId]) {
    return NextResponse.json({ error: 'Invalid anchor ID' }, { status: 400 });
  }

  try {
    const info = await getAnchorInfo(anchorId);
    const config = ANCHOR_CONFIGS[anchorId];

    return NextResponse.json({
      anchor: {
        id: anchorId,
        name: config.name,
        description: config.description,
        withdrawTypes: config.withdrawTypes,
      },
      withdraw: info.withdraw,
    });
  } catch (error) {
    logger.error({ err: error }, 'Error getting anchor info:');
    return NextResponse.json(
      { error: 'Failed to get anchor info' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/sep24/withdraw
 * 
 * Initiate a SEP-24 withdrawal
 * Body: { anchorId, amount, asset? }
 */
export async function POST(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '');
  const claims = await verifyAuthToken(authToken || '');
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { anchorId, amount, asset = 'USDC' } = body;

  if (!anchorId || !ANCHOR_CONFIGS[anchorId as AnchorId]) {
    return NextResponse.json({ error: 'Invalid anchor ID' }, { status: 400 });
  }

  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    include: {
      wallet: true,
      anchorSessions: {
        where: { anchorId },
      },
    },
  });

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  if (!user.wallet) {
    return NextResponse.json({ error: 'No wallet connected' }, { status: 400 });
  }

  // Check for valid session
  const session = user.anchorSessions[0];
  if (!session || isTokenExpired(session.expiresAt)) {
    return NextResponse.json(
      { error: 'Not authenticated with anchor. Please authenticate first.' },
      { status: 401 }
    );
  }

  try {
    // Initiate withdrawal with anchor
    const withdrawResponse = await initiateWithdrawal(
      anchorId,
      session.jwtToken,
      asset,
      amount,
      user.wallet.address
    );

    // Determine withdraw type based on anchor
    const withdrawType = ANCHOR_CONFIGS[anchorId as AnchorId].withdrawTypes[0];

    // Create withdrawal transaction record
    const withdrawalTx = await prisma.withdrawalTransaction.create({
      data: {
        userId: user.id,
        anchorId,
        stellarTxId: withdrawResponse.id,
        amount: new Decimal(amount),
        asset,
        status: 'interactive',
        interactiveUrl: withdrawResponse.url,
        withdrawType,
      },
    });

    return NextResponse.json({
      success: true,
      transactionId: withdrawalTx.id,
      stellarTxId: withdrawResponse.id,
      interactiveUrl: withdrawResponse.url,
      anchorId,
      amount,
      asset,
    });
  } catch (error) {
    logger.error({ err: error }, 'Withdrawal initiation error:');
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to initiate withdrawal' },
      { status: 500 }
    );
  }
}
