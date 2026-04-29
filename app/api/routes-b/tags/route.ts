import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { createTagSchema } from './schema'
import { TAG_LIMITS } from '../_lib/limits'
import { getCachedTags, setCachedTags, invalidateTagsCache } from '../_lib/cache'

export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // Check cache first
  const cached = await getCachedTags(user.id)
  if (cached) {
    return NextResponse.json(cached)
  }

  // Single optimized query with combined usage count (invoices + contacts)
  const tags = await prisma.tag.findMany({
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
        },
      },
    },
  })

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
}

export async function POST(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // Invalidate cache on tag creation
  invalidateTagsCache(user.id)

  try {
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

    return NextResponse.json(
      {
        id: result.id,
        name: result.name,
        color: result.color,
        usageCount: 0,                    // New tag has zero usage
      },
      { status: 201 }
    )
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
}