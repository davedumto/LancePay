import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── GET /api/routes-d/profile — get current user's profile ──────────

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      include: {
        wallet: { select: { address: true } },
        _count: { select: { bankAccounts: true } },
      },
    })

    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    return NextResponse.json({
      profile: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        timezone: (user as any).timezone ?? null,
        createdAt: user.createdAt,
        wallet: user.wallet ?? null,
        bankAccountCount: user._count.bankAccounts,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Profile GET error')
    return NextResponse.json({ error: 'Failed to get profile' }, { status: 500 })
  }
}

// ── PATCH /api/routes-d/profile — update display name and timezone ───

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const body = await request.json()
    const updateData: Record<string, any> = {}

    // Validate and collect name
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return NextResponse.json({ error: 'Name must be a non-empty string' }, { status: 400 })
      }
      if (body.name.length > 100) {
        return NextResponse.json({ error: 'Name must be 100 characters or fewer' }, { status: 400 })
      }
      updateData.name = body.name.trim()
    }

    // Validate and collect timezone
    if (body.timezone !== undefined) {
      if (typeof body.timezone !== 'string' || !isValidTimezone(body.timezone)) {
        return NextResponse.json(
          { error: 'Invalid timezone. Must be a valid IANA timezone (e.g. "Africa/Lagos", "UTC")' },
          { status: 400 }
        )
      }
      updateData.timezone = body.timezone
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: updateData,
    })

    return NextResponse.json({
      id: updated.id,
      name: updated.name,
      timezone: (updated as any).timezone ?? null,
    })
  } catch (error) {
    logger.error({ err: error }, 'Profile PATCH error')
    return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 })
  }
}
