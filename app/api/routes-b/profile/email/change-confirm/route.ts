import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { consumeToken } from '../../../_lib/email-change-tokens'

const CONSUME_ERRORS: Record<string, { message: string; status: number }> = {
  invalid_token: { message: 'Invalid or unknown token', status: 400 },
  expired: { message: 'Token has expired', status: 400 },
  already_used: { message: 'Token has already been used', status: 400 },
  user_mismatch: { message: 'Token does not belong to this user', status: 403 },
}

// ── POST /api/routes-b/profile/email/change-confirm ─────────────────
// Body: { token: string }
// Validates and consumes the single-use token, then updates the email.

export async function POST(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const claims = await verifyAuthToken(authToken)
  if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const body = await request.json()
  const { token } = body

  if (!token || typeof token !== 'string') {
    return NextResponse.json({ error: 'token is required' }, { status: 400 })
  }

  const result = consumeToken(token, user.id)

  if (!result.ok) {
    const { message, status } = CONSUME_ERRORS[result.error]
    return NextResponse.json({ error: message }, { status })
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { email: result.newEmail },
  })

  return NextResponse.json({ emailUpdated: true, email: result.newEmail })
}
