import { withRequestId } from '../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { withBodyLimit } from '../_lib/with-body-limit'
import { registerRoute } from '../_lib/openapi'
import { z } from 'zod'

// OPENAPI: GET TAGS
registerRoute({
  method: 'GET',
  path: '/tags',
  summary: 'List tags',
  description: 'Get all tags for the authenticated user with invoice counts.',
  responseSchema: z.object({
    tags: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        color: z.string(),
        invoiceCount: z.number(),
        createdAt: z.string(),
      })
    ),
  }),
  tags: ['tags'],
})

// OPENAPI: CREATE TAG
registerRoute({
  method: 'POST',
  path: '/tags',
  summary: 'Create tag',
  description: 'Create a new tag for organizing invoices.',
  requestSchema: z.object({
    name: z.string().min(1).max(50),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#6366f1'),
  }),
  responseSchema: z.object({
    id: z.string(),
    name: z.string(),
    color: z.string(),
    invoiceCount: z.number(),
  }),
  tags: ['tags'],
})

/**
 * AUTH
 */
async function getUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')

  if (!claims) return null

  return prisma.user.findUnique({
    where: { privyId: claims.userId },
  })
}

/**
 * GET TAGS
 */
async function GETHandler(request: NextRequest) {
  const user = await getUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const tags = await prisma.tag.findMany({
    where: { userId: user.id },
    orderBy: { name: 'asc' },
    include: {
      _count: { select: { invoiceTags: true } },
    },
  })

  return NextResponse.json({
    tags: tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      invoiceCount: tag._count.invoiceTags,
      createdAt: tag.createdAt,
    })),
  })
}

/**
 * CREATE TAG
 */
async function POSTHandler(request: NextRequest) {
  const user = await getUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { name?: string; color?: string }

  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.name || typeof body.name !== 'string') {
    return NextResponse.json({ error: 'Invalid name' }, { status: 400 })
  }

  const tag = await prisma.tag.create({
    data: {
      userId: user.id,
      name: body.name.trim(),
      color: body.color || '#6366f1',
    },
    include: {
      _count: { select: { invoiceTags: true } },
    },
  })

  return NextResponse.json({
    id: tag.id,
    name: tag.name,
    color: tag.color,
    invoiceCount: tag._count.invoiceTags,
  })
}

/**
 * EXPORT
 */
export const GET = withRequestId(GETHandler)
export const POST = withRequestId(
  withBodyLimit(POSTHandler, { limitBytes: 1024 * 1024 })
)