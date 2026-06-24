import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '../_shared/logger'
import { getAuthenticatedUser } from '../_shared/auth'

const CreateApiKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
})

type ApiKeyDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
  create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getApiKeyDelegate(): ApiKeyDelegate {
  return (prisma as unknown as { apiKey: ApiKeyDelegate }).apiKey
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

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
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      body = {}
    }

    const parsed = CreateApiKeySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.format() },
        { status: 400 },
      )
    }

    const rawKey = `rk_${crypto.randomBytes(24).toString('hex')}`
    const keyHint = rawKey.slice(-6)
    const created = await getApiKeyDelegate().create({
      data: {
        userId: user.id,
        name: parsed.data.name,
        keyHint,
        hashedKey: crypto.createHash('sha256').update(rawKey).digest('hex'),
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

    return NextResponse.json(
      {
        apiKey: rawKey,
        key: created,
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/api-keys error')
    return NextResponse.json({ error: 'Failed to create API key' }, { status: 500 })
  }
}
