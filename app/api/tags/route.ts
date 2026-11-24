import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/

const createTagSchema = z
  .object({
    name: z.string().trim().min(1).max(50),
    color: z.string().regex(HEX_COLOR, 'Color must be a 7-character hex code'),
  })
  .strict()

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

const tagSelect = { id: true, name: true, color: true, createdAt: true } as const

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const tags = await prisma.tag.findMany({
      where: { userId: user.id },
      select: tagSelect,
      orderBy: { name: 'asc' },
    })
    return NextResponse.json({ tags })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tags error')
    return NextResponse.json({ error: 'Failed to fetch tags' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let body: unknown = {}
    const rawBody = await request.text()
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody)
      } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
      }
    }

    const parsed = createTagSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }

    const tag = await prisma.tag.create({
      data: { userId: user.id, name: parsed.data.name, color: parsed.data.color },
      select: tagSelect,
    })
    return NextResponse.json({ tag }, { status: 201 })
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      return NextResponse.json({ error: 'A tag with that name already exists' }, { status: 409 })
    }
    logger.error({ err: error }, 'POST /api/tags error')
    return NextResponse.json({ error: 'Failed to create tag' }, { status: 500 })
  }
}
