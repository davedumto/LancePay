import crypto from 'node:crypto'

import { withRequestId } from '../_lib/with-request-id'
import { withBodyLimit } from '../_lib/with-body-limit'
import { withMethods } from '../_lib/with-methods'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { normalizeString } from '../_lib/normalize'

import { registerRoute } from '../_lib/openapi'
import { z } from 'zod'

import {
  getIdempotentResponse,
  setIdempotentResponse,
} from '../_lib/idempotency'

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

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

  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    )
  }

  const tags = await prisma.tag.findMany({
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
        },
      },
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

/* ---------------- POST ---------------- */

async function POSTHandler(request: NextRequest) {
  const user = await getAuthenticatedUser(request)

  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    )
  }

  const idempotencyKey = request.headers.get('idempotency-key')

  let body: {
    name?: unknown
    color?: unknown
  }

  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 }
    )
  }

  const bodyHash = idempotencyKey ? crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex') : ''

  if (idempotencyKey) {
    const cached = getIdempotentResponse(idempotencyKey)

    if (cached) {
      if (cached.bodyHash !== bodyHash) {
        return NextResponse.json(
          { error: 'Idempotency-Key conflict' },
          { status: 409 }
        )
      }

      return NextResponse.json(
        cached.body,
        { status: cached.status }
      )
    }
  }

  const name =
    typeof body.name === 'string'
      ? normalizeString(body.name)
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

  if (name.length > 50) {
    return NextResponse.json(
      {
        error:
          'Tag name must be at most 50 characters',
      },
      { status: 400 }
    )
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

  const responseBody = {
    id: tag.id,
    name: tag.name,
    color: tag.color,
    invoiceCount: tag._count.invoiceTags,
  }

  if (idempotencyKey) {
    setIdempotentResponse(
      idempotencyKey,
      {
        bodyHash,
        status: 201,
        body: responseBody,
      },
      IDEMPOTENCY_TTL_MS
    )
  }

  return NextResponse.json(
    responseBody,
    { status: 201 }
  )
}

/* ---------------- EXPORTS ---------------- */

export const { GET, POST } = withMethods({
  GET: withRequestId(GETHandler),
  POST: withRequestId(
    withBodyLimit(POSTHandler, {
      limitBytes: 1024 * 1024,
    })
  ),
})