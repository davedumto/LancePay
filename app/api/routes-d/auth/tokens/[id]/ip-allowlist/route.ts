import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/
const IPV6_RE = /^[0-9a-fA-F:]+(\/.{1,3})?$/

function isValidCidr(ip: string): boolean {
  return IPV4_RE.test(ip.trim()) || IPV6_RE.test(ip.trim())
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const apiToken = await prisma.apiToken.findFirst({
      where: { id: (await params).id, userId: user.id },
    })
    if (!apiToken) return NextResponse.json({ error: 'Token not found' }, { status: 404 })

    const entries = await prisma.tokenIpAllowlist.findMany({
      where: { tokenId: (await params).id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, cidr: true, label: true, createdAt: true },
    })

    return NextResponse.json({ entries })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/auth/tokens/[id]/ip-allowlist error')
    return NextResponse.json({ error: 'Failed to fetch IP allowlist' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const apiToken = await prisma.apiToken.findFirst({
      where: { id: (await params).id, userId: user.id },
    })
    if (!apiToken) return NextResponse.json({ error: 'Token not found' }, { status: 404 })

    const body = await request.json()
    const { cidr, label } = body

    if (!cidr || typeof cidr !== 'string' || !isValidCidr(cidr)) {
      return NextResponse.json({ error: 'cidr must be a valid IPv4/IPv6 address or CIDR range' }, { status: 400 })
    }

    const existing = await prisma.tokenIpAllowlist.findFirst({
      where: { tokenId: (await params).id, cidr: cidr.trim() },
    })
    if (existing) {
      return NextResponse.json({ error: 'CIDR already in allowlist' }, { status: 409 })
    }

    const entry = await prisma.tokenIpAllowlist.create({
      data: {
        tokenId: (await params).id,
        cidr: cidr.trim(),
        label: label?.trim() ?? null,
      },
      select: { id: true, cidr: true, label: true, createdAt: true },
    })

    return NextResponse.json({ entry }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/auth/tokens/[id]/ip-allowlist error')
    return NextResponse.json({ error: 'Failed to add IP to allowlist' }, { status: 500 })
  }
}
