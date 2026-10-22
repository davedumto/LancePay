import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { Account, MuxedAccount, StrKey } from '@stellar/stellar-sdk'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const RESERVED_LABEL = /^(?:system|internal|platform)(?:[:/]|$)/i

function deriveMuxedId(label: string): bigint {
  const digest = createHash('sha256')
    .update(`lancepay:muxed-account:${label.length}:${label}`)
    .digest()
  return BigInt(`0x${digest.subarray(0, 8).toString('hex')}`)
}

export async function GET(request: NextRequest) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const claims = await verifyAuthToken(token)
  if (!claims?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    include: { wallet: true },
  })
  const parentAccount = user?.wallet?.address

  if (!parentAccount || !StrKey.isValidEd25519PublicKey(parentAccount)) {
    return NextResponse.json({ error: 'A valid wallet is required' }, { status: 404 })
  }

  const label = new URL(request.url).searchParams.get('label')?.trim().toLowerCase() ?? ''
  if (!label || label.length > 128 || !/^[a-z0-9][a-z0-9._-]*$/.test(label)) {
    return NextResponse.json({ error: 'Label must use letters, numbers, dots, underscores, or hyphens' }, { status: 400 })
  }
  if (RESERVED_LABEL.test(label)) {
    return NextResponse.json({ error: 'That label is reserved' }, { status: 400 })
  }

  const muxedAddress = new MuxedAccount(new Account(parentAccount, '0'), deriveMuxedId(label).toString()).accountId()

  return NextResponse.json({ muxedAddress, parentAccount, label })
}