import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { invalidateApiKeyCache, verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * DELETE /api/api-keys/[id]
 *
 * Soft-revokes an API key by setting `isActive: false` and `deactivatesAt: now`
 * (preserving the database row for audit history while immediately ending any
 * rotation grace window) and invalidating the request-time API key cache.
 *
 * Only the key owner may revoke their own key.
 */
export async function DELETE(
  request: NextRequest,
  context?: { params?: Promise<{ id: string }> | { id: string } },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const resolvedParams = context?.params ? await context.params : undefined
    const urlSegments = new URL(request.url).pathname.split('/').filter(Boolean)
    const fallbackId = urlSegments[urlSegments.indexOf('api-keys') + 1]
    const keyId = (resolvedParams?.id ?? fallbackId ?? '').trim()

    if (!keyId) {
      return NextResponse.json(
        { error: 'API key ID is required' },
        { status: 400 },
      )
    }

    const apiKey = await prisma.apiKey.findUnique({
      where: { id: keyId },
      select: {
        id: true,
        userId: true,
        name: true,
        keyHint: true,
        hashedKey: true,
        isActive: true,
        deactivatesAt: true,
      },
    })

    if (!apiKey) {
      return NextResponse.json({ error: 'API key not found' }, { status: 404 })
    }

    if (apiKey.userId !== user.id) {
      return NextResponse.json(
        { error: 'Forbidden: you do not own this API key' },
        { status: 403 },
      )
    }

    if (!apiKey.isActive) {
      return NextResponse.json(
        { error: 'API key is already revoked' },
        { status: 409 },
      )
    }

    const revokedAt = new Date()

    const updated = await prisma.apiKey.update({
      where: { id: keyId },
      data: {
        isActive: false,
        deactivatesAt: revokedAt,
      },
      select: {
        id: true,
        name: true,
        keyHint: true,
        isActive: true,
        deactivatesAt: true,
        lastUsedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    // Immediately invalidate any request-time cached key state
    invalidateApiKeyCache(apiKey.id, apiKey.hashedKey)

    logger.info(
      { keyId: apiKey.id, userId: user.id, revokedAt: revokedAt.toISOString() },
      'API key revoked',
    )

    return NextResponse.json(
      {
        message: 'API key revoked successfully',
        apiKey: {
          ...updated,
          revokedAt: revokedAt.toISOString(),
        },
      },
      { status: 200 },
    )
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/api-keys/[id] error')
    return NextResponse.json(
      { error: 'Failed to revoke API key' },
      { status: 500 },
    )
  }
}
