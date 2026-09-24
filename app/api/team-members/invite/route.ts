import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { getAuthenticatedUser, resolveTeamRole } from '@/lib/team'
import { canInvite, isTeamRole } from '@/lib/team-roles'

// GET  /api/team-members/invite — list the team members and seat usage for a team
// POST /api/team-members/invite — invite a new member (pending) within the seat cap

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Statuses that consume a seat (an accepted member or an outstanding invite).
const SEAT_CONSUMING_STATUSES = ['pending', 'active'] as const

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    // Default to the caller's own account; allow admins to query a team they belong to.
    const ownerId = searchParams.get('ownerId') || user.id

    const callerRole = await resolveTeamRole(ownerId, user.id)
    if (!callerRole) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const owner = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { teamSeatLimit: true },
    })
    if (!owner) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 })
    }

    const members = await prisma.teamMember.findMany({
      where: { ownerId },
      orderBy: { invitedAt: 'asc' },
    })

    const seatsUsed = members.filter((m: { status: string }) =>
      (SEAT_CONSUMING_STATUSES as readonly string[]).includes(m.status),
    ).length

    return NextResponse.json({
      members,
      seatLimit: owner.teamSeatLimit,
      seatsUsed,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/team-members/invite error')
    return NextResponse.json({ error: 'Failed to fetch team members' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as { email?: string; role?: string; ownerId?: string }
    const ownerId = payload.ownerId || user.id
    const role = payload.role ?? 'viewer'
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''

    if (!email || !EMAIL_REGEX.test(email)) {
      return NextResponse.json({ error: 'A valid email is required' }, { status: 400 })
    }

    // Ownership cannot be granted through an invitation.
    if (!isTeamRole(role) || role === 'owner') {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
    }

    // Only an owner or admin may invite.
    const callerRole = await resolveTeamRole(ownerId, user.id)
    if (!callerRole || !canInvite(callerRole)) {
      return NextResponse.json({ error: 'Only an owner or admin may invite members' }, { status: 403 })
    }

    const owner = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { teamSeatLimit: true },
    })
    if (!owner) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 })
    }

    // Reject duplicate invitations / existing memberships for the same email.
    const existing = await prisma.teamMember.findFirst({
      where: { ownerId, email },
    })
    if (existing && existing.status !== 'removed') {
      const message =
        existing.status === 'pending'
          ? 'An invitation for this email is already pending'
          : 'This email is already a team member'
      return NextResponse.json({ error: message }, { status: 409 })
    }

    // Enforce the seat cap over active + pending rows.
    const seatsUsed = await prisma.teamMember.count({
      where: { ownerId, status: { in: [...SEAT_CONSUMING_STATUSES] } },
    })
    if (seatsUsed >= owner.teamSeatLimit) {
      return NextResponse.json(
        { error: 'Seat limit reached for this account' },
        { status: 403 },
      )
    }

    // Re-invite a previously removed member by reactivating their row, otherwise
    // create a fresh pending invite. The @@unique([ownerId, email]) constraint
    // means at most one row per email exists.
    const member = existing
      ? await prisma.teamMember.update({
          where: { id: existing.id },
          data: {
            role,
            status: 'pending',
            invitedAt: new Date(),
            acceptedAt: null,
            removedAt: null,
          },
        })
      : await prisma.teamMember.create({
          data: { ownerId, email, role, status: 'pending' },
        })

    logger.info(
      { ownerId, invitedEmail: email, role, memberId: member.id },
      'POST /api/team-members/invite',
    )

    return NextResponse.json({ member }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/team-members/invite error')
    return NextResponse.json({ error: 'Failed to invite team member' }, { status: 500 })
  }
}
