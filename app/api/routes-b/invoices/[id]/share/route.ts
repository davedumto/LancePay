import { withRequestId } from '../../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function POSTHandler(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const { id } = await context.params

  const invoice = await prisma.invoice.findFirst({
    where: { id, userId: user.id },
    select: { id: true, status: true },
  })
  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  let body: { channels?: unknown; message?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const channels = Array.isArray(body.channels) ? body.channels : ['link']
  const allowedChannels = ['link', 'email', 'slack']
  const invalidCh = channels.filter((c: unknown) => !allowedChannels.includes(c as string))
  if (invalidCh.length > 0) {
    return NextResponse.json(
      { error: `Invalid channels: ${invalidCh.join(', ')}` },
      { status: 422 },
    )
  }

  const token = Buffer.from(`${invoice.id}:${Date.now()}`).toString('base64url')
  const shareUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/i/${token}`

  logger.info({ userId: user.id, invoiceId: id, channels }, 'Invoice share link generated')

  return NextResponse.json({
    invoiceId: id,
    shareUrl,
    channels,
    message: body.message ?? null,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  })
}

export const POST = withRequestId(POSTHandler)
