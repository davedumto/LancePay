import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const ALLOWED_ROLES = ['freelancer', 'admin', 'client'] as const
type AllowedRole = typeof ALLOWED_ROLES[number]

async function getAdminUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, role: true },
  })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const actor = await getAdminUser(request)
  if (!actor) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (actor.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 })
  }

  const { id: memberId } = params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const role = (body as Record<string, unknown>)?.role
  if (!role || typeof role !== 'string' || !ALLOWED_ROLES.includes(role as AllowedRole)) {
    return NextResponse.json(
      { error: `role must be one of: ${ALLOWED_ROLES.join(', ')}` },
      { status: 400 },
    )
  }

  const target = await prisma.user.findUnique({
    where: { id: memberId },
    select: { id: true, role: true, email: true },
  })

  if (!target) {
    return NextResponse.json({ error: 'Member not found' }, { status: 404 })
  }

  if (target.id === actor.id) {
    return NextResponse.json({ error: 'Cannot change your own role' }, { status: 422 })
  }

  const updated = await prisma.user.update({
    where: { id: memberId },
    data: { role: role as AllowedRole },
    select: { id: true, email: true, role: true, updatedAt: true },
  })

  return NextResponse.json({ member: updated })
}
