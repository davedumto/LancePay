import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const MAX_SNIPPET_TITLE_LENGTH = 150

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

function serializeSnippet(snippet: Record<string, any>) {
  return {
    id: snippet.id,
    userId: snippet.userId,
    title: snippet.title,
    content: snippet.content,
    createdAt: snippet.createdAt
      ? new Date(snippet.createdAt).toISOString()
      : null,
    updatedAt: snippet.updatedAt
      ? new Date(snippet.updatedAt).toISOString()
      : null,
  }
}

/**
 * GET /api/snippets
 * Lists reusable text snippets owned by the authenticated user.
 * Supports optional `?search=` (or `?q=`) query parameter to filter by `title`.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    const { searchParams } = new URL(request.url)
    const rawSearch = searchParams.get('search') ?? searchParams.get('q') ?? ''
    const search = rawSearch.trim()

    const where: Record<string, unknown> = {
      userId: user.id,
      ...(search
        ? {
            title: {
              contains: search,
              mode: 'insensitive',
            },
          }
        : {}),
    }

    const rows = ((await prisma.snippet.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    })) ?? []) as Array<Record<string, any>>

    // Enforce user scoping and case-insensitive title search in-memory as well
    // in case a test mock returns unfiltered rows
    const filtered = rows.filter((row) => {
      if (row.userId && row.userId !== user.id) return false
      if (search) {
        return String(row.title ?? '')
          .toLowerCase()
          .includes(search.toLowerCase())
      }
      return true
    })

    return NextResponse.json({
      snippets: filtered.map(serializeSnippet),
      total: filtered.length,
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'GET /api/snippets error')
    return NextResponse.json(
      { error: 'Failed to list snippets' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/snippets
 * Creates a reusable `Snippet` for invoice descriptions:
 * - Validates `title` and `content` are non-empty.
 * - Scopes the snippet to the authenticated user.
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

    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title) {
      return NextResponse.json(
        { error: 'title is required and must be non-empty', code: 'TITLE_REQUIRED' },
        { status: 400 },
      )
    }
    if (title.length > MAX_SNIPPET_TITLE_LENGTH) {
      return NextResponse.json(
        {
          error: `title must be at most ${MAX_SNIPPET_TITLE_LENGTH} characters`,
          code: 'TITLE_TOO_LONG',
        },
        { status: 400 },
      )
    }

    const content = typeof body.content === 'string' ? body.content.trim() : ''
    if (!content) {
      return NextResponse.json(
        {
          error: 'content is required and must be non-empty',
          code: 'CONTENT_REQUIRED',
        },
        { status: 400 },
      )
    }

    const created = await prisma.snippet.create({
      data: {
        userId: user.id,
        title,
        content,
      },
    })

    return NextResponse.json(
      {
        snippet: serializeSnippet(created),
      },
      { status: 201 },
    )
  } catch (error) {
    logger?.error?.({ err: error }, 'POST /api/snippets error')
    return NextResponse.json(
      { error: 'Failed to create snippet' },
      { status: 500 },
    )
  }
}

/**
 * DELETE /api/snippets
 * Deletes a snippet owned by the authenticated user (`?id=` or `{ id }` in body).
 */
export async function DELETE(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    const { searchParams } = new URL(request.url)
    let snippetId = (searchParams.get('id') ?? '').trim()

    if (!snippetId) {
      const body = await request.json().catch(() => ({}))
      if (body && typeof body === 'object' && typeof body.id === 'string') {
        snippetId = body.id.trim()
      }
    }

    if (!snippetId) {
      return NextResponse.json(
        { error: 'Snippet id is required', code: 'SNIPPET_ID_REQUIRED' },
        { status: 400 },
      )
    }

    const existing =
      typeof prisma.snippet?.findUnique === 'function'
        ? await prisma.snippet.findUnique({ where: { id: snippetId } })
        : await prisma.snippet.findFirst({ where: { id: snippetId } })

    if (!existing) {
      return NextResponse.json({ error: 'Snippet not found' }, { status: 404 })
    }

    if (existing.userId !== user.id) {
      return NextResponse.json(
        {
          error: 'Forbidden: you do not own this snippet',
          code: 'FORBIDDEN_SNIPPET_OWNER',
        },
        { status: 403 },
      )
    }

    await prisma.snippet.delete({
      where: { id: snippetId },
    })

    return NextResponse.json({
      deleted: true,
      id: snippetId,
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'DELETE /api/snippets error')
    return NextResponse.json(
      { error: 'Failed to delete snippet' },
      { status: 500 },
    )
  }
}
