import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const DEFAULT_TAG_COLOR = '#6366f1'
export const MAX_TAG_NAME_LENGTH = 50
const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/

export function isValidHexColor(color: string): boolean {
  return HEX_COLOR_REGEX.test(color)
}

async function authenticate(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return {
      error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }),
    }
  }

  const user =
    (await prisma.user.findUnique({ where: { privyId: claims.userId } })) ??
    (await prisma.user.findUnique({ where: { id: claims.userId } }))
  if (!user) {
    return {
      error: NextResponse.json({ error: 'User not found' }, { status: 404 }),
    }
  }

  return { user }
}

function serializeTag(tag: Record<string, any>) {
  return {
    id: tag.id,
    userId: tag.userId,
    name: tag.name,
    color: tag.color ?? DEFAULT_TAG_COLOR,
    createdAt: tag.createdAt ? new Date(tag.createdAt).toISOString() : null,
  }
}

/**
 * GET /api/tags
 * Returns the authenticated user's full tag list sorted by `name` ascending.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    const rows = ((await prisma.tag.findMany({
      where: { userId: user.id },
      orderBy: { name: 'asc' },
    })) ?? []) as Array<Record<string, any>>

    const sorted = [...rows]
      .filter((r) => !r.userId || r.userId === user.id)
      .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))

    return NextResponse.json({
      tags: sorted.map(serializeTag),
      total: sorted.length,
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'GET /api/tags error')
    return NextResponse.json(
      { error: 'Failed to list tags' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/tags
 * Creates a reusable `Tag` (`name`, `color`) that can be attached to invoices:
 * - Enforces the unique `(userId, name)` constraint with a clean `409` on collision.
 * - Validates `color` is a valid 7-character hex code (`^#[0-9A-Fa-f]{6}$`) matching the schema's format.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    let body: Record<string, unknown>
    try {
      body = ((await request.json()) ?? {}) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) {
      return NextResponse.json(
        { error: 'name is required and must be non-empty', code: 'NAME_REQUIRED' },
        { status: 400 },
      )
    }
    if (name.length > MAX_TAG_NAME_LENGTH) {
      return NextResponse.json(
        {
          error: `name must be at most ${MAX_TAG_NAME_LENGTH} characters`,
          code: 'NAME_TOO_LONG',
        },
        { status: 400 },
      )
    }

    let color = DEFAULT_TAG_COLOR
    if (body.color !== undefined && body.color !== null) {
      if (typeof body.color !== 'string' || !isValidHexColor(body.color.trim())) {
        return NextResponse.json(
          {
            error:
              'color must be a valid 7-character hex code (e.g. "#6366f1")',
            code: 'INVALID_TAG_COLOR',
          },
          { status: 400 },
        )
      }
      color = body.color.trim().toLowerCase()
    }

    let existing: Record<string, any> | null = null
    if (typeof prisma.tag?.findUnique === 'function') {
      existing = await prisma.tag.findUnique({
        where: {
          userId_name: {
            userId: user.id,
            name,
          },
        },
      })
    } else if (typeof prisma.tag?.findFirst === 'function') {
      existing = await prisma.tag.findFirst({
        where: { userId: user.id, name },
      })
    }

    if (existing) {
      return NextResponse.json(
        {
          error: `A tag named "${name}" already exists`,
          code: 'TAG_NAME_ALREADY_EXISTS',
        },
        { status: 409 },
      )
    }

    let created: Record<string, any>
    try {
      created = await prisma.tag.create({
        data: {
          userId: user.id,
          name,
          color,
        },
      })
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return NextResponse.json(
          {
            error: `A tag named "${name}" already exists`,
            code: 'TAG_NAME_ALREADY_EXISTS',
          },
          { status: 409 },
        )
      }
      throw err
    }

    return NextResponse.json(
      {
        tag: serializeTag(created),
      },
      { status: 201 },
    )
  } catch (error) {
    logger?.error?.({ err: error }, 'POST /api/tags error')
    return NextResponse.json(
      { error: 'Failed to create tag' },
      { status: 500 },
    )
  }
}
