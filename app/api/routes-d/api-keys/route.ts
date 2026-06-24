import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { generateToken, hashToken } from '@/lib/crypto'

const MAX_NAME_LENGTH = 100

type ApiKeyDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
  create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getApiKeyDelegate(): ApiKeyDelegate {
  return (prisma as unknown as { apiKey: ApiKeyDelegate }).apiKey
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const apiKeys = await getApiKeyDelegate().findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        keyHint: true,
        isActive: true,
        lastUsedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ apiKeys })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/api-keys error')
    return NextResponse.json({ error: 'Failed to list API keys' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => null)) as { name?: string } | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const { name } = body
    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }

    const trimmedName = name.trim()
    if (trimmedName.length > MAX_NAME_LENGTH) {
      return NextResponse.json(
        { error: `name must be at most ${MAX_NAME_LENGTH} characters` },
        { status: 400 },
      )
    }

    const plainKey = `lp_${generateToken()}`
    const hashedKey = hashToken(plainKey)
    const keyHint = `lp_...${plainKey.slice(-4)}`

    const apiKey = await getApiKeyDelegate().create({
      data: {
        userId: user.id,
        name: trimmedName,
        keyHint,
        hashedKey,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        keyHint: true,
        isActive: true,
        lastUsedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ apiKey, key: plainKey }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/api-keys error')
    return NextResponse.json({ error: 'Failed to create API key' }, { status: 500 })
  }
}
