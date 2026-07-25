import { isIP } from 'net'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const MAX_LABEL_LENGTH = 100

function isValidIpOrCidr(value: string): boolean {
  const slashIndex = value.indexOf('/')
  if (slashIndex === -1) return isIP(value) !== 0

  const address = value.slice(0, slashIndex)
  const prefixPart = value.slice(slashIndex + 1)
  if (!/^\d{1,3}$/.test(prefixPart)) return false

  const prefix = Number(prefixPart)
  const version = isIP(address)
  if (version === 4) return prefix <= 32
  if (version === 6) return prefix <= 128
  return false
}

async function resolveContext(request: NextRequest, tokenId: string) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return { error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) }
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
  if (!user) {
    return { error: NextResponse.json({ error: 'User not found' }, { status: 401 }) }
  }

  const apiKey = await prisma.apiKey.findFirst({
    where: { id: tokenId, userId: user.id },
    select: { id: true },
  })
  if (!apiKey) {
    return { error: NextResponse.json({ error: 'Token not found' }, { status: 404 }) }
  }

  return { user, apiKey }
}

const entrySelect = {
  id: true,
  cidr: true,
  label: true,
  createdAt: true,
} as const

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const ctx = await resolveContext(request, id)
    if (ctx.error) return ctx.error

    const entries = await prisma.apiKeyIpAllowlist.findMany({
      where: { apiKeyId: ctx.apiKey.id },
      orderBy: { createdAt: 'asc' },
      select: entrySelect,
    })

    return NextResponse.json({ entries })
  } catch (error) {
    logger.error({ err: error }, 'GET /auth/tokens/[id]/ip-allowlist error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const ctx = await resolveContext(request, id)
    if (ctx.error) return ctx.error

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { cidr, label } = (body ?? {}) as { cidr?: unknown; label?: unknown }

    if (typeof cidr !== 'string' || cidr.trim() === '') {
      return NextResponse.json({ error: 'cidr must be a non-empty string' }, { status: 400 })
    }
    const normalizedCidr = cidr.trim()
    if (!isValidIpOrCidr(normalizedCidr)) {
      return NextResponse.json(
        { error: 'cidr must be a valid IP address or CIDR range' },
        { status: 400 },
      )
    }

    if (label !== undefined && typeof label !== 'string') {
      return NextResponse.json({ error: 'label must be a string' }, { status: 400 })
    }
    if (typeof label === 'string' && label.trim().length > MAX_LABEL_LENGTH) {
      return NextResponse.json(
        { error: `label must be at most ${MAX_LABEL_LENGTH} characters` },
        { status: 400 },
      )
    }

    const existing = await prisma.apiKeyIpAllowlist.findFirst({
      where: { apiKeyId: ctx.apiKey.id, cidr: normalizedCidr },
      select: { id: true },
    })
    if (existing) {
      return NextResponse.json(
        { error: 'This IP or range is already on the allowlist' },
        { status: 409 },
      )
    }

    const entry = await prisma.apiKeyIpAllowlist.create({
      data: {
        apiKeyId: ctx.apiKey.id,
        cidr: normalizedCidr,
        label: typeof label === 'string' && label.trim() !== '' ? label.trim() : null,
      },
      select: entrySelect,
    })

    return NextResponse.json({ entry }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /auth/tokens/[id]/ip-allowlist error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
