import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAnchorSecret, verifySEP24Signature } from '@/lib/sep24-webhook-verify'

export async function POST(request: NextRequest) {
  const signature = request.headers.get('x-sep24-signature')
  if (!signature) {
    console.warn('SEP-24 webhook rejected: missing signature header')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const anchorIdRaw = request.nextUrl.searchParams.get('anchor')
  if (!anchorIdRaw) {
    console.warn('SEP-24 webhook rejected: missing anchor query parameter')
    return NextResponse.json({ error: 'Missing anchor ID' }, { status: 400 })
  }

  const normalizedAnchor = anchorIdRaw.toLowerCase()
  const internalAnchorIds = normalizedAnchor === 'yellow-card'
    ? ['yellow-card', 'yellowcard']
    : [normalizedAnchor]

  const rawBody = await request.text()

  let secret: string
  try {
    secret = getAnchorSecret(normalizedAnchor)
  } catch (error) {
    console.error('SEP-24 webhook rejected: unknown anchor', { anchorId: normalizedAnchor, error })
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const isValidSignature = verifySEP24Signature(rawBody, signature, secret)
  if (!isValidSignature) {
    console.warn('SEP-24 webhook rejected: invalid signature or stale timestamp', {
      anchorId: normalizedAnchor,
    })
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 })
  }

  const txId = typeof body.id === 'string' ? body.id : null
  const status = typeof body.status === 'string' ? body.status : null

  if (!txId || !status) {
    return NextResponse.json(
      { error: 'Payload must include id and status' },
      { status: 400 }
    )
  }

  const withdrawal = await prisma.withdrawalTransaction.findFirst({
    where: {
      stellarTxId: txId,
      anchorId: { in: internalAnchorIds },
    },
  })

  if (!withdrawal) {
    console.warn('SEP-24 webhook rejected: unknown transaction', { anchorId: normalizedAnchor, txId })
    return NextResponse.json({ error: 'Unknown transaction' }, { status: 404 })
  }

  await prisma.withdrawalTransaction.update({
    where: { id: withdrawal.id },
    data: {
      status,
      completedAt: status === 'completed' ? new Date() : withdrawal.completedAt,
      error: status === 'failed' ? JSON.stringify(body) : null,
    },
  })

  console.info('SEP-24 webhook processed', {
    anchorId: normalizedAnchor,
    txId,
    status,
  })

  return NextResponse.json({ success: true })
}
