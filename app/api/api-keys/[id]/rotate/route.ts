import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateToken, hashToken } from '@/lib/crypto'

// Grace period: 24 hours (in milliseconds)
const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const keyId = (await params).id

  // Look up the old API key
  const oldApiKey = await prisma.apiKey.findUnique({
    where: { id: keyId },
    select: {
      id: true,
      userId: true,
      name: true,
      isActive: true,
    },
  })

  // Key not found
  if (!oldApiKey) {
    return NextResponse.json({ error: 'API key not found' }, { status: 404 })
  }

  // Check ownership - only the key's owner can rotate it
  if (oldApiKey.userId !== user.id) {
    return NextResponse.json(
      { error: 'Forbidden: you do not own this API key' },
      { status: 403 }
    )
  }

  // Reject rotation of already inactive keys
  if (!oldApiKey.isActive) {
    return NextResponse.json(
      { error: 'Cannot rotate an inactive or revoked API key' },
      { status: 400 }
    )
  }

  // Generate new raw API key and hash it
  const newRawKey = generateToken()
  const newHashedKey = hashToken(newRawKey)
  const newKeyHint = newRawKey.slice(0, 8) + '...' + newRawKey.slice(-4)

  // Calculate deactivation time for old key (grace period from now)
  const deactivatesAt = new Date(Date.now() + GRACE_PERIOD_MS)

  try {
    // Use a transaction to ensure atomicity:
    // 1. Create new ApiKey (active immediately)
    // 2. Schedule old key deactivation (set deactivatesAt, keep isActive=true for grace period)
    const result = await prisma.$transaction(async (tx) => {
      // Create the new API key
      const createdNewKey = await tx.apiKey.create({
        data: {
          userId: user.id,
          name: oldApiKey.name,
          keyHint: newKeyHint,
          hashedKey: newHashedKey,
          isActive: true,
          deactivatesAt: null,
        },
        select: {
          id: true,
          name: true,
          keyHint: true,
          isActive: true,
          createdAt: true,
        },
      })

      // Schedule old key deactivation by setting deactivatesAt
      // Keep isActive=true so it remains valid during grace period
      await tx.apiKey.update({
        where: { id: keyId },
        data: {
          deactivatesAt,
        },
      })

      return createdNewKey
    })

    // Return the new key with raw value (only time it's ever returned)
    // Never log the raw key value
    return NextResponse.json(
      {
        message: 'API key rotated successfully',
        newApiKey: {
          ...result,
          rawKey: newRawKey, // Only returned once - never persisted in plaintext
        },
        graceInfo: {
          oldKeyDeactivatesAt: deactivatesAt.toISOString(),
          gracePeriodHours: 24,
          message: 'Old key remains valid during grace period for in-flight integrations',
        },
      },
      { status: 201 }
    )
  } catch (error) {
    // Log error without exposing raw key or sensitive details
    console.error('API key rotation failed:', {
      keyId,
      userId: user.id,
      error: error instanceof Error ? error.message : 'Unknown error',
    })

    return NextResponse.json(
      { error: 'Failed to rotate API key. Please try again.' },
      { status: 500 }
    )
  }
}
