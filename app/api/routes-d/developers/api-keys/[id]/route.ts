import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthContext } from '@/app/api/routes-d/disputes/_shared'
import { logger } from '@/lib/logger'

// DELETE /api/routes-d/developers/api-keys/[id] - Deactivate API key
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 })
    }

    const { id } = await params

    // Find the API key
    const apiKey = await prisma.apiKey.findUnique({
      where: { id },
      select: { userId: true, name: true, isActive: true }
    })

    if (!apiKey) {
      return NextResponse.json({ error: 'API key not found' }, { status: 404 })
    }

    // Verify ownership
    if (apiKey.userId !== auth.user.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    if (!apiKey.isActive) {
      return NextResponse.json({ error: 'API key is already inactive' }, { status: 400 })
    }

    // Deactivate the key (soft delete)
    await prisma.apiKey.update({
      where: { id },
      data: { isActive: false, updatedAt: new Date() }
    })

    return NextResponse.json({
      message: 'API key deactivated successfully',
      apiKey: { id, name: apiKey.name }
    })
  } catch (error) {
    logger.error({ err: error }, 'API key deactivation error:')
    return NextResponse.json(
      { error: 'Failed to deactivate API key' },
      { status: 500 }
    )
  }
}
