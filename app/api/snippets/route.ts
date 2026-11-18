import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const createSnippetSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(150),
    content: z.string().trim().min(1, 'Content is required'),
  })
  .strict()

type CreateSnippetInput = z.infer<typeof createSnippetSchema>

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

/**
 * GET /api/snippets
 * Returns the caller's snippets, optionally filtered by title search query
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search')?.trim()

    const snippets = await prisma.snippet.findMany({
      where: {
        userId: user.id,
        ...(search && { title: { contains: search, mode: 'insensitive' } }),
      },
      select: { id: true, title: true, content: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    })

    return NextResponse.json({ snippets })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/snippets error')
    return NextResponse.json({ error: 'Failed to fetch snippets' }, { status: 500 })
  }
}

/**
 * POST /api/snippets
 * Creates a new snippet for the authenticated user
 */
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

    const parsed = createSnippetSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }

    const snippet = await prisma.snippet.create({
      data: {
        userId: user.id,
        title: parsed.data.title,
        content: parsed.data.content,
      },
      select: { id: true, title: true, content: true, createdAt: true, updatedAt: true },
    })

    logger.info({ userId: user.id, snippetId: snippet.id }, 'Snippet created')

    return NextResponse.json({ snippet }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/snippets error')
    return NextResponse.json({ error: 'Failed to create snippet' }, { status: 500 })
  }
}

/**
 * DELETE /api/snippets?id=<id>
 * Deletes a snippet belonging to the authenticated user
 */
export async function DELETE(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { searchParams } = new URL(request.url)
    const snippetId = searchParams.get('id')?.trim()

    if (!snippetId) {
      return NextResponse.json({ error: 'Snippet ID is required' }, { status: 400 })
    }

    const snippet = await prisma.snippet.findUnique({
      where: { id: snippetId },
      select: { userId: true },
    })

    if (!snippet) {
      return NextResponse.json({ error: 'Snippet not found' }, { status: 404 })
    }

    if (snippet.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    await prisma.snippet.delete({
      where: { id: snippetId },
    })

    logger.info({ userId: user.id, snippetId }, 'Snippet deleted')

    return NextResponse.json({ success: true }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/snippets error')
    return NextResponse.json({ error: 'Failed to delete snippet' }, { status: 500 })
  }
}
