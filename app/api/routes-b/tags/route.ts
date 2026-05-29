import { withRequestId } from '../_lib/with-request-id'
import { withBodyLimit } from '../_lib/with-body-limit'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { createTagSchema } from './schema'
import { TAG_LIMITS } from '../_lib/limits'
import { getCachedTags, setCachedTags, invalidateTagsCache } from '../_lib/cache'

<<<<<<< HEAD
import { registerRoute } from '../_lib/openapi'
import { z } from 'zod'

/* ---------------- OPENAPI ---------------- */

registerRoute({
  method: 'GET',
  path: '/tags',
  summary: 'List tags',
  description:
    'Get all tags for the authenticated user with invoice counts.',
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

registerRoute({
  method: 'POST',
  path: '/tags',
  summary: 'Create tag',
  description: 'Create a tag for organizing invoices.',
  requestSchema: z.object({
    name: z.string().min(1).max(50),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .default('#6366f1'),
  }),
  responseSchema: z.object({
    id: z.string(),
    name: z.string(),
    color: z.string(),
    invoiceCount: z.number(),
  }),
  tags: ['tags'],
})

/* ---------------- AUTH ---------------- */

async function getAuthenticatedUser(
  request: NextRequest
) {
  const authToken = request.headers
    .get('authorization')
    ?.replace('Bearer ', '')

  const claims = await verifyAuthToken(
    authToken || ''
  )

  if (!claims) return null

  return prisma.user.findUnique({
    where: {
      privyId: claims.userId,
    },
  })
}

/* ---------------- GET ---------------- */

async function GETHandler(request: NextRequest) {
  const user = await getAuthenticatedUser(request)
=======
export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
>>>>>>> 9a09f79 (feat(routes-b): validate hex color and enforce 100 tag limit per user- Add strict #RRGGBB hex color validation)

  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    )
  }

  // Check cache first
  const cached = await getCachedTags(user.id)
  if (cached) {
    return NextResponse.json(cached)
  }

  // Single optimized query with combined usage count (invoices + contacts)
  const tags = await prisma.tag.findMany({
<<<<<<< HEAD
    where: {
      userId: user.id,
    },

    orderBy: {
      name: 'asc',
    },

    include: {
      _count: {
        select: {
          invoiceTags: true,
=======
    where: { userId: user.id },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      color: true,
      createdAt: true,
      _count: {
        select: {
          invoiceTags: true,   // usage in invoices
          contactTags: true,   // usage in contacts
<<<<<<< HEAD
>>>>>>> 7added4 (feat(routes-b): add usageCount to tags GET endpoint with caching)
=======
>>>>>>> c5bb930d507df139703c52f2ff5dcff787713d4e
        },
      },
    },
  })

<<<<<<< HEAD
<<<<<<< HEAD
  return NextResponse.json({
    tags: tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      invoiceCount: tag._count.invoiceTags,
      createdAt: tag.createdAt,
    })),
  })
=======
=======
>>>>>>> c5bb930d507df139703c52f2ff5dcff787713d4e
  const enrichedTags = tags.map((tag) => ({
    id: tag.id,
    name: tag.name,
    color: tag.color,
    usageCount: tag._count.invoiceTags + tag._count.contactTags,   // Combined usage
    createdAt: tag.createdAt,
  }))

  const responseData = { tags: enrichedTags }

  // Cache the response for 30 seconds
  setCachedTags(user.id, responseData)

  return NextResponse.json(responseData)
<<<<<<< HEAD
>>>>>>> 7added4 (feat(routes-b): add usageCount to tags GET endpoint with caching)
=======
>>>>>>> c5bb930d507df139703c52f2ff5dcff787713d4e
}

/* ---------------- POST ---------------- */

async function POSTHandler(request: NextRequest) {
  const user = await getAuthenticatedUser(request)

  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    )
  }

  let body: {
    name?: unknown
    color?: unknown
  }

  // Invalidate cache on tag creation
  invalidateTagsCache(user.id)

  try {
<<<<<<< HEAD
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 }
    )
  }

  const name =
    typeof body.name === 'string'
      ? body.name.trim()
      : ''

  const color =
    typeof body.color === 'string'
      ? body.color
      : '#6366f1'

  if (!name) {
    return NextResponse.json(
      { error: 'Tag name is required' },
      { status: 400 }
    )
  }
=======
    const body = await request.json()

    // === NEW VALIDATION USING SCHEMA (Issue #536) ===
    const validated = createTagSchema.parse(body)

    // Atomic check for tag limit + creation to prevent race conditions
    const result = await prisma.$transaction(async (tx) => {
      const currentCount = await tx.tag.count({
        where: { userId: user.id },
      })

      if (currentCount >= TAG_LIMITS.MAX_TAGS_PER_USER) {
        throw new Error('TAG_LIMIT_EXCEEDED')
      }

      // Duplicate check
      const existingTag = await tx.tag.findUnique({
        where: { userId_name: { userId: user.id, name: validated.name } },
      })

      if (existingTag) {
        throw new Error('DUPLICATE_TAG')
      }

      return tx.tag.create({
        data: {
          userId: user.id,
          name: validated.name,
          color: validated.color,
        },
      })
    })
>>>>>>> 7added4 (feat(routes-b): add usageCount to tags GET endpoint with caching)

  if (name.length > 50) {
    return NextResponse.json(
      {
<<<<<<< HEAD
<<<<<<< HEAD
        error:
          'Tag name must be at most 50 characters',
=======
=======
>>>>>>> c5bb930d507df139703c52f2ff5dcff787713d4e
        id: result.id,
        name: result.name,
        color: result.color,
        usageCount: 0,                    // New tag has zero usage
<<<<<<< HEAD
>>>>>>> 7added4 (feat(routes-b): add usageCount to tags GET endpoint with caching)
=======
>>>>>>> c5bb930d507df139703c52f2ff5dcff787713d4e
      },
      { status: 400 }
    )
<<<<<<< HEAD
<<<<<<< HEAD
  }

  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
    return NextResponse.json(
      { error: 'Invalid hex color format' },
      { status: 400 }
    )
  }

  const existing = await prisma.tag.findUnique({
    where: {
      userId_name: {
        userId: user.id,
        name,
      },
    },
  })

  if (existing) {
    return NextResponse.json(
      { error: 'Tag already exists' },
      { status: 409 }
    )
  }

  const tag = await prisma.tag.create({
    data: {
      userId: user.id,
      name,
      color,
    },

    include: {
      _count: {
        select: {
          invoiceTags: true,
        },
      },
    },
  })

  return NextResponse.json(
    {
      id: tag.id,
      name: tag.name,
      color: tag.color,
      invoiceCount: tag._count.invoiceTags,
    },
    { status: 201 }
  )
}

/* ---------------- EXPORTS ---------------- */

export const GET = withRequestId(GETHandler)

export const POST = withRequestId(
  withBodyLimit(POSTHandler, {
    limitBytes: 1024 * 1024,
  })
)
=======
=======
>>>>>>> c5bb930d507df139703c52f2ff5dcff787713d4e
  } catch (error: any) {
    // Handle validation errors
    if (error.name === 'ZodError') {
      return NextResponse.json(
        { 
          error: 'Validation failed', 
          details: error.errors.map((e: any) => e.message) 
        },
        { status: 400 }
      )
    }

    // Handle tag limit exceeded
    if (error.message === 'TAG_LIMIT_EXCEEDED') {
      return NextResponse.json(
        { error: `Maximum of ${TAG_LIMITS.MAX_TAGS_PER_USER} tags per user reached` },
        { status: 409 }
      )
    }

    // Handle duplicate tag
    if (error.message === 'DUPLICATE_TAG') {
      return NextResponse.json(
        { error: 'Tag with this name already exists' },
        { status: 409 }
      )
    }

    console.error('Tag creation error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
<<<<<<< HEAD
}
>>>>>>> 7added4 (feat(routes-b): add usageCount to tags GET endpoint with caching)
=======
}
>>>>>>> c5bb930d507df139703c52f2ff5dcff787713d4e
