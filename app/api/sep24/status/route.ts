/**
 * SEP-24 Transaction Status API
 * 
 * Handles transaction status polling and payment submission.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyAuthToken } from '@/lib/auth';
import { 
  getTransaction, 
  needsPayment,
  isTerminalStatus,
  getStatusMessage 
} from '@/lib/stellar/sep24';
import { type AnchorId, ANCHOR_CONFIGS } from '@/lib/stellar/anchors';
import { isTokenExpired } from '@/lib/stellar/sep10';
import { logger } from '@/lib/logger'

/**
 * GET /api/sep24/status
 * 
 * Get the status of a withdrawal transaction
 * Query params: transactionId (our internal ID) or stellarTxId (anchor's ID)
 */
export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '');
  const claims = await verifyAuthToken(authToken || '');
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const transactionId = searchParams.get('transactionId');
  const stellarTxId = searchParams.get('stellarTxId');

  if (!transactionId && !stellarTxId) {
    return NextResponse.json(
      { error: 'Missing transactionId or stellarTxId' },
      { status: 400 }
    );
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
  });

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  // Find the withdrawal transaction
  const withdrawalTx = await prisma.withdrawalTransaction.findFirst({
    where: {
      userId: user.id,
      ...(transactionId ? { id: transactionId } : { stellarTxId }),
    },
  });

  if (!withdrawalTx) {
    return NextResponse.json(
      { error: 'Transaction not found' },
      { status: 404 }
    );
  }

  // Check for valid session to poll anchor
  const session = await prisma.anchorSession.findUnique({
    where: {
      userId_anchorId: {
        userId: user.id,
        anchorId: withdrawalTx.anchorId,
      },
    },
  });

  let anchorStatus = null;

  if (session && !isTokenExpired(session.expiresAt) && withdrawalTx.stellarTxId) {
    try {
      // Fetch latest status from anchor
      anchorStatus = await getTransaction(
        withdrawalTx.anchorId as AnchorId,
        session.jwtToken,
        withdrawalTx.stellarTxId
      );

      // Update our record if status changed
      if (anchorStatus.status !== withdrawalTx.status) {
        const updateData: any = {
          status: anchorStatus.status,
        };

        // Capture anchor's withdraw address and memo for payment
        if (anchorStatus.withdraw_anchor_account) {
          updateData.withdrawAddress = anchorStatus.withdraw_anchor_account;
        }
        if (anchorStatus.withdraw_memo) {
          updateData.withdrawMemo = anchorStatus.withdraw_memo;
        }
        if (anchorStatus.withdraw_memo_type) {
          updateData.withdrawMemoType = anchorStatus.withdraw_memo_type;
        }
        if (isTerminalStatus(anchorStatus.status)) {
          updateData.completedAt = new Date();
        }

        await prisma.withdrawalTransaction.update({
          where: { id: withdrawalTx.id },
          data: updateData,
        });
      }
    } catch (error) {
      logger.error({ err: error }, 'Error fetching anchor status:');
      // Continue with cached status
    }
  }

  return NextResponse.json({
    id: withdrawalTx.id,
    stellarTxId: withdrawalTx.stellarTxId,
    anchorId: withdrawalTx.anchorId,
    amount: withdrawalTx.amount.toString(),
    asset: withdrawalTx.asset,
    status: anchorStatus?.status || withdrawalTx.status,
    statusMessage: getStatusMessage(anchorStatus?.status || withdrawalTx.status as any),
    interactiveUrl: withdrawalTx.interactiveUrl,
    withdrawAddress: anchorStatus?.withdraw_anchor_account || withdrawalTx.withdrawAddress,
    withdrawMemo: anchorStatus?.withdraw_memo || withdrawalTx.withdrawMemo,
    withdrawMemoType: anchorStatus?.withdraw_memo_type || withdrawalTx.withdrawMemoType,
    withdrawType: withdrawalTx.withdrawType,
    needsPayment: needsPayment(anchorStatus?.status || withdrawalTx.status as any),
    isComplete: isTerminalStatus(anchorStatus?.status || withdrawalTx.status as any),
    createdAt: withdrawalTx.createdAt.toISOString(),
    completedAt: withdrawalTx.completedAt?.toISOString(),
    error: withdrawalTx.error,
  });
}

/**
 * POST /api/sep24/status
 * 
 * Update transaction after payment has been submitted
 * Body: { transactionId, stellarTxHash }
 */
export async function POST(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '');
  const claims = await verifyAuthToken(authToken || '');
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { transactionId, stellarTxHash } = body;

  if (!transactionId || !stellarTxHash) {
    return NextResponse.json(
      { error: 'Missing transactionId or stellarTxHash' },
      { status: 400 }
    );
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
  });

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  // Find and update the withdrawal transaction
  const withdrawalTx = await prisma.withdrawalTransaction.findFirst({
    where: {
      id: transactionId,
      userId: user.id,
    },
  });

  if (!withdrawalTx) {
    return NextResponse.json(
      { error: 'Transaction not found' },
      { status: 404 }
    );
  }

  // Update with payment hash
  const updated = await prisma.withdrawalTransaction.update({
    where: { id: transactionId },
    data: {
      stellarTxHash,
      status: 'submitted',
    },
  });

  return NextResponse.json({
    success: true,
    id: updated.id,
    stellarTxHash: updated.stellarTxHash,
    status: updated.status,
  });
}

/**
 * GET /api/sep24/status/history
 * 
 * Get withdrawal history for the user
 */
export async function DELETE(request: NextRequest) {
  // Using DELETE as a workaround since we can't have multiple GET handlers
  // This is actually a GET for history - clients should use GET with ?history=true
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
