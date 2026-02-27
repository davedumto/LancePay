/**
 * SEP-10 Authentication API
 * 
 * Handles the SEP-10 challenge-response flow for anchor authentication.
 * Stores JWT tokens in the database for subsequent SEP-24 requests.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyAuthToken } from '@/lib/auth';
import {
  getChallenge,
  verifyChallenge,
  submitSignedChallenge,
  prepareForWalletSigning,
  isTokenExpired
} from '@/lib/stellar/sep10';
import { type AnchorId, ANCHOR_CONFIGS } from '@/lib/stellar/anchors';
import { logger } from '@/lib/logger'

/**
 * GET /api/sep24/auth
 * 
 * Get a valid session for an anchor, or return challenge if none exists
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

  if (!anchorId || !ANCHOR_CONFIGS[anchorId as AnchorId]) {
    return NextResponse.json({ error: 'Invalid anchor ID' }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    include: { wallet: true, anchorSessions: true }
  });

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  if (!user.wallet) {
    return NextResponse.json({ error: 'No wallet connected' }, { status: 400 });
  }

  // Check for existing valid session
  const existingSession = user.anchorSessions.find(
    (s: any) => s.anchorId === anchorId && !isTokenExpired(s.expiresAt)
  );

  if (existingSession) {
    return NextResponse.json({
      authenticated: true,
      anchorId,
      expiresAt: existingSession.expiresAt.toISOString(),
    });
  }

  // No valid session, return that authentication is needed
  return NextResponse.json({
    authenticated: false,
    anchorId,
    walletAddress: user.wallet.address,
  });
}

/**
 * POST /api/sep24/auth
 * 
 * Handle SEP-10 authentication flow
 * Body: { anchorId, action: 'challenge' | 'submit', signedXdr? }
 */
export async function POST(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '');
  const claims = await verifyAuthToken(authToken || '');
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { anchorId, action, signedXdr } = body;

  if (!anchorId || !ANCHOR_CONFIGS[anchorId as AnchorId]) {
    return NextResponse.json({ error: 'Invalid anchor ID' }, { status: 400 });
  }

  if (!action || !['challenge', 'submit'].includes(action)) {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    include: { wallet: true }
  });

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  if (!user.wallet) {
    return NextResponse.json({ error: 'No wallet connected' }, { status: 400 });
  }

  try {
    if (action === 'challenge') {
      // Step 1: Get challenge from anchor
      const challenge = await getChallenge(anchorId, user.wallet.address);

      // Verify the challenge is legitimate
      const isValid = await verifyChallenge(
        challenge.transaction,
        anchorId,
        user.wallet.address
      );

      if (!isValid) {
        return NextResponse.json(
          { error: 'Invalid challenge from anchor' },
          { status: 400 }
        );
      }

      // Return challenge for client-side signing
      const signingData = prepareForWalletSigning(challenge.transaction);

      return NextResponse.json({
        action: 'sign_challenge',
        ...signingData,
        anchorId,
      });
    }

    if (action === 'submit') {
      // Step 2: Submit signed challenge and get JWT
      if (!signedXdr) {
        return NextResponse.json(
          { error: 'Missing signed transaction' },
          { status: 400 }
        );
      }

      const tokenResponse = await submitSignedChallenge(anchorId, signedXdr);

      // Store the session in database
      await prisma.anchorSession.upsert({
        where: {
          userId_anchorId: {
            userId: user.id,
            anchorId,
          },
        },
        update: {
          jwtToken: tokenResponse.token,
          expiresAt: tokenResponse.expiresAt,
        },
        create: {
          userId: user.id,
          anchorId,
          jwtToken: tokenResponse.token,
          expiresAt: tokenResponse.expiresAt,
        },
      });

      return NextResponse.json({
        authenticated: true,
        anchorId,
        expiresAt: tokenResponse.expiresAt.toISOString(),
      });
    }
  } catch (error) {
    logger.error({ err: error }, 'SEP-10 auth error:');
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Authentication failed' },
      { status: 500 }
    );
  }
}
