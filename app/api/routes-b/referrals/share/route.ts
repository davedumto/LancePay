import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireScope, RoutesBForbiddenError } from '../../_lib/authz'
import { errorResponse } from '../../_lib/errors'
import { z } from 'zod'
import crypto from 'crypto'

const ShareReferralSchema = z.object({
  recipientEmail: z.string().email(),
  message: z.string().max(500).optional(),
})

async function POSTHandler(request: NextRequest) {
  try {
    const auth = await requireScope(request, 'routes-b:read')

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('BAD_REQUEST', 'Invalid JSON body', {}, 400)
    }

    const parsed = ShareReferralSchema.safeParse(body)
    if (!parsed.success) {
      const fields: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.')
        fields[key] = issue.message
      }
      return errorResponse('BAD_REQUEST', 'Validation failed', { fields }, 400)
    }

    const { recipientEmail, message } = parsed.data

    // Get the user's referral code (generate if missing)
    let user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { id: true, referralCode: true, name: true, email: true },
    })

    if (!user) {
      return errorResponse('NOT_FOUND', 'User not found', {}, 404)
    }

    // Generate referral code if not set
    if (!user.referralCode) {
      const referralCode = crypto.randomBytes(4).toString('hex')
      await prisma.user.update({
        where: { id: auth.userId },
        data: { referralCode },
      })
      user = { ...user, referralCode }
    }

    // Build the share link
    const referralLink = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://lancepay.app'}/signup?ref=${user.referralCode}`

    return NextResponse.json(
      {
        shareLink: referralLink,
        recipientEmail,
        message: message ?? null,
        referralCode: user.referralCode,
      },
      { status: 201 },
    )
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', {}, 401)
    }
    return errorResponse('INTERNAL', 'Failed to create referral share link', {}, 500)
  }
}

export const POST = withRequestId(POSTHandler)