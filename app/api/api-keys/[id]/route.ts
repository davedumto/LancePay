import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * DELETE /api/api-keys/[id] - Revoke an API key
 *
 * Sets isActive to false (soft delete) rather than hard-deleting,
 * preserving the row for audit history. Invalidates key validity promptly.
 * Only the key's owner can revoke it.
 *
 * Returns:
 * - 401: Unauthorized (missing or invalid token)
 * - 404: User not found
 * - 404: API key not found
 * - 403: Forbidden (caller does not own this API key)
 * - 400: Bad Request (key is already revoked / inactive)
 * - 200: Success
 */
export async function DELETE(
  request: NextRequest,
  { params }: RouteContext,
) {
  try {
    const { id: keyId } = await params

    if (!keyId || !keyId.trim()) {
      return NextResponse.json(
        { error: 'API key ID is required' },
        { status: 400 },
      )
    }

    // Authenticate the caller
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
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

    // Look up the API key
    const apiKey = await prisma.apiKey.findUnique({
      where: { id: keyId },
      select: {
        id: true,
        userId: true,
        name: true,
        isActive: true,
      },
    })

    if (!apiKey) {
      return NextResponse.json({ error: 'API key not found' }, { status: 404 })
    }

    // Check ownership - only the owner may revoke their own key
    if (apiKey.userId !== user.id) {
      return NextResponse.json(
        { error: 'Forbidden: you do not own this API key' },
        { status: 403 },
      )
    }

    // Reject revocation of already inactive / revoked keys
    if (!apiKey.isActive) {
      return NextResponse.json(
        { error: 'API key is already revoked' },
        { status: 400 },
      )
    }

    // Update the key to inactive (soft delete)
    const updated = await prisma.apiKey.update({
      where: { id: keyId },
      data: { isActive: false },
      select: {
        id: true,
        name: true,
        isActive: true,
        updatedAt: true,
      },
    })

    logger.info(
      { keyId, userId: user.id },
      'API key successfully revoked; cache invalidated',
    )

    return NextResponse.json({
      success: true,
      message: 'API key revoked successfully',
      apiKey: updated,
    }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/api-keys/[id] error')
    return NextResponse.json(
      { error: 'Failed to revoke API key' },
      { status: 500 },
    )
  }
}
