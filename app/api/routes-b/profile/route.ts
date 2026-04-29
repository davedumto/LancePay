import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { redactProfile, parseRevealQuery, isAdminRequest } from '../_lib/redact'

// ── GET /api/routes-b/profile — get current user's profile ──────────

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    })

    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    // Parse reveal query parameters
    const { searchParams } = new URL(request.url)
    const revealFields = parseRevealQuery(searchParams)
    const isAdmin = isAdminRequest(request)

    // Apply redaction
    const redactedProfile = redactProfile(user, {
      policy: 'masked',
      revealFields,
      isAdmin,
    })

    // Create audit log entry if revealing PII
    if (revealFields.length > 0 && isAdmin) {
      await prisma.auditEvent.create({
        data: {
          userId: user.id,
          action: 'PROFILE_PII_REVEALED',
          entityType: 'User',
          entityId: user.id,
          metadata: {
            revealedFields: revealFields,
            revealedAt: new Date().toISOString(),
          },
        },
      })
    }

    return NextResponse.json(redactedProfile)
  } catch (error) {
    logger.error({ err: error }, 'Profile GET error')
    return NextResponse.json({ error: 'Failed to get profile' }, { status: 500 })
  }
}

// ── PATCH /api/routes-b/profile — update user's display name ────────

export async function PATCH(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const body = await request.json()

    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return NextResponse.json({ error: 'Name is required and must be a non-empty string' }, { status: 400 })
    }

    if (body.name.length > 100) {
      return NextResponse.json({ error: 'Name must be 100 characters or fewer' }, { status: 400 })
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { name: body.name.trim() },
    })

    return NextResponse.json({
      id: updated.id,
      name: updated.name,
      email: updated.email,
    })
  } catch (error) {
    logger.error({ err: error }, 'Profile PATCH error')
    return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 })
  }
}
