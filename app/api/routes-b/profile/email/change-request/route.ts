import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { issueToken } from '../../../_lib/email-change-tokens'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// ── POST /api/routes-b/profile/email/change-request ─────────────────
// Body: { newEmail: string }
// Issues a single-use 24-hour token bound to the authenticated user.
// The token must be confirmed via /profile/email/change-confirm.

export async function POST(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const claims = await verifyAuthToken(authToken)
  if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const body = await request.json()
  const { newEmail } = body

  if (!newEmail || typeof newEmail !== 'string') {
    return NextResponse.json({ error: 'newEmail is required' }, { status: 400 })
  }
  if (!EMAIL_REGEX.test(newEmail)) {
    return NextResponse.json({ error: 'newEmail must be a valid email address' }, { status: 400 })
  }
  if (newEmail.toLowerCase() === (user.email ?? '').toLowerCase()) {
    return NextResponse.json(
      { error: 'newEmail must be different from the current email' },
      { status: 400 },
    )
  }

  issueToken(user.id, user.email ?? '', newEmail)
  return NextResponse.json({ tokenIssued: true })
}
