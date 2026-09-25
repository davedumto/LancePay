import { timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

// Trusted internal jobs (e.g. the dispute-resolution worker) authenticate with
// `Authorization: Bearer <BADGE_SYSTEM_SECRET>`, mirroring the CRON_SECRET
// convention. Identity comes only from this credential — never from a body field.
export type BadgeActor =
  | { kind: 'system' }
  | { kind: 'user'; id: string; role: string }

function isSystemCredential(token: string): boolean {
  const secret = process.env.BADGE_SYSTEM_SECRET
  if (!secret) return false
  const expected = Buffer.from(secret)
  const provided = Buffer.from(token)
  return expected.length === provided.length && timingSafeEqual(expected, provided)
}

export function isAdmin(actor: BadgeActor): boolean {
  return actor.kind === 'user' && actor.role === 'admin'
}

export async function resolveBadgeActor(
  request: NextRequest
): Promise<{ actor: BadgeActor } | { response: NextResponse }> {
  const token = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  if (isSystemCredential(token)) return { actor: { kind: 'system' } }

  const claims = await verifyAuthToken(token)
  if (!claims) return { response: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, role: true },
  })
  if (!user) return { response: NextResponse.json({ error: 'User not found' }, { status: 404 }) }

  return { actor: { kind: 'user', id: user.id, role: user.role } }
}
