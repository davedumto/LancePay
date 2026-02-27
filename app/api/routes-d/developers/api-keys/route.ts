import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthContext } from '@/app/api/routes-d/disputes/_shared'
import { generateApiKey } from '@/lib/api-keys'
import { createApiKeySchema } from '@/lib/validations'
import { logger } from '@/lib/logger'

// GET /api/routes-d/developers/api-keys - List user's API keys
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 })
    }

    const apiKeys = await prisma.apiKey.findMany({
      where: { userId: auth.user.id },
      select: {
        id: true,
        name: true,
        keyHint: true,
        isActive: true,
        lastUsedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' }
    })

    return NextResponse.json({ apiKeys })
  } catch (error) {
    logger.error({ err: error }, 'API keys GET error:')
    return NextResponse.json(
      { error: 'Failed to fetch API keys' },
      { status: 500 }
    )
  }
}

// POST /api/routes-d/developers/api-keys - Generate new API key
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 })
    }

    // Rate limit: Max 10 active keys per user
    const activeKeysCount = await prisma.apiKey.count({
      where: {
        userId: auth.user.id,
        isActive: true
      }
    })

    if (activeKeysCount >= 10) {
      return NextResponse.json(
        { error: 'Maximum of 10 active API keys allowed. Please deactivate some keys first.' },
        { status: 429 }
      )
    }

    // Validate request body
    const body = await request.json()
    const parsed = createApiKeySchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Invalid request' },
        { status: 400 }
      )
    }

    // Generate new API key
    const { fullKey, keyHint, hashedKey } = generateApiKey()

    // Store in database
    const apiKey = await prisma.apiKey.create({
      data: {
        userId: auth.user.id,
        name: parsed.data.name,
        keyHint,
        hashedKey,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        keyHint: true,
        createdAt: true,
      }
    })

    // Return full key ONLY ONCE
    return NextResponse.json(
      {
        message: 'API key created successfully. Save this key securely - it will not be shown again.',
        apiKey: {
          ...apiKey,
          key: fullKey, // Only time the full key is exposed
        }
      },
      { status: 201 }
    )
  } catch (error) {
    logger.error({ err: error }, 'API key creation error:')
    return NextResponse.json(
      { error: 'Failed to create API key' },
      { status: 500 }
    )
  }
}
