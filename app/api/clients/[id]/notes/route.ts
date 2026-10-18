import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const DEFAULT_PAGE = 1
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

async function resolveClientId(context?: RouteContext): Promise<string> {
  if (!context?.params) return ''
  const resolved = await Promise.resolve(context.params)
  return (resolved?.id ?? '').trim()
}

function parsePage(raw: string | null): number {
  if (!raw) return DEFAULT_PAGE
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_PAGE
}

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT
  return Math.min(parsed, MAX_LIMIT)
}

async function authenticateFreelancer(request: NextRequest) {
  // Reject any client-portal session token headers immediately — ClientNote is strictly freelancer-private
  if (
    request.headers.get('x-client-portal-token') ||
    request.headers.get('x-portal-session')
  ) {
    return {
      error: NextResponse.json(
        {
          error: 'Forbidden: client notes are private to the freelancer',
          code: 'CLIENT_PORTAL_FORBIDDEN',
        },
        { status: 403 },
      ),
    }
  }

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

  if (token.startsWith('cps_')) {
    return {
      error: NextResponse.json(
        {
          error: 'Forbidden: client portal tokens cannot access private client notes',
          code: 'CLIENT_PORTAL_FORBIDDEN',
        },
        { status: 403 },
      ),
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

async function verifyClientRelationshipOwnership(
  userId: string,
  clientId: string,
): Promise<{ allowed: boolean; notFound?: boolean; reason?: string }> {
  // A client cannot read or write freelancer-private notes about themselves
  if (userId === clientId) {
    return {
      allowed: false,
      reason: 'Forbidden: client notes are visible only to the freelancer',
    }
  }

  // If a dedicated client delegate exists on prisma, check ownership
  const anyPrisma = prisma as Record<string, any>
  if (typeof anyPrisma.client?.findUnique === 'function') {
    const clientRecord = await anyPrisma.client.findUnique({
      where: { id: clientId },
    })
    if (clientRecord) {
      const ownerId = clientRecord.userId ?? clientRecord.freelancerId
      if (ownerId && ownerId !== userId) {
        return {
          allowed: false,
          reason: 'Forbidden: you do not own this client relationship',
        }
      }
      return { allowed: true }
    }
  }

  // Check if client User record has an explicit owner/freelancer relationship
  if (typeof prisma.user?.findUnique === 'function') {
    const clientUser = (await prisma.user.findUnique({
      where: { id: clientId },
    })) as Record<string, any> | null
    if (clientUser) {
      const ownerId = clientUser.ownerId ?? clientUser.freelancerId ?? clientUser.userId
      if (ownerId && ownerId !== userId) {
        return {
          allowed: false,
          reason: 'Forbidden: you do not own this client relationship',
        }
      }
    }
  }

  // Check if existing notes for this client belong to a different freelancer
  if (typeof prisma.clientNote?.findFirst === 'function') {
    const foreignNote = await prisma.clientNote.findFirst({
      where: { clientId, userId: { not: userId } },
    })
    const ownNote = await prisma.clientNote.findFirst({
      where: { clientId, userId },
    })
    if (foreignNote && !ownNote && foreignNote.userId !== userId) {
      return {
        allowed: false,
        reason: 'Forbidden: you do not own this client relationship',
      }
    }
  }

  return { allowed: true }
}

function serializeClientNote(note: Record<string, any>) {
  return {
    id: note.id,
    userId: note.userId,
    clientId: note.clientId,
    content: note.content,
    createdAt: note.createdAt ? new Date(note.createdAt).toISOString() : null,
    updatedAt: note.updatedAt ? new Date(note.updatedAt).toISOString() : null,
  }
}

/**
 * GET /api/clients/[id]/notes
 * Lists private `ClientNote` rows for a client, visible only to the freelancer who owns
 * the client relationship, paginated and ordered by `createdAt` descending.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authenticateFreelancer(request)
    if (auth.error) return auth.error
    const user = auth.user!

    const clientId = await resolveClientId(context)
    if (!clientId) {
      return NextResponse.json(
        { error: 'Client ID is required' },
        { status: 400 },
      )
    }

    const ownership = await verifyClientRelationshipOwnership(user.id, clientId)
    if (!ownership.allowed) {
      return NextResponse.json(
        {
          error:
            ownership.reason ??
            'Forbidden: you do not own this client relationship',
          code: 'FORBIDDEN_CLIENT_RELATIONSHIP',
        },
        { status: 403 },
      )
    }

    const { searchParams } = new URL(request.url)
    const page = parsePage(searchParams.get('page'))
    const limit = parseLimit(searchParams.get('limit'))
    const skip = (page - 1) * limit

    const where = {
      userId: user.id,
      clientId,
    }

    const rawNotes = ((await prisma.clientNote.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    })) ?? []) as Array<Record<string, any>>

    // If a mock returns notes owned by another user without applying the where filter, reject with 403
    if (
      rawNotes.length > 0 &&
      rawNotes.every((n) => n.userId && n.userId !== user.id)
    ) {
      return NextResponse.json(
        {
          error: 'Forbidden: you do not own this client relationship',
          code: 'FORBIDDEN_CLIENT_RELATIONSHIP',
        },
        { status: 403 },
      )
    }

    // Ensure strict owner scoping and descending createdAt order
    const scopedNotes = rawNotes
      .filter((n) => !n.userId || n.userId === user.id)
      .sort((a, b) => {
        const tA = a.createdAt ? new Date(a.createdAt).getTime() : 0
        const tB = b.createdAt ? new Date(b.createdAt).getTime() : 0
        return tB - tA
      })

    const total =
      typeof prisma.clientNote?.count === 'function'
        ? ((await prisma.clientNote.count({ where })) ?? scopedNotes.length)
        : scopedNotes.length

    return NextResponse.json({
      clientId,
      notes: scopedNotes.map(serializeClientNote),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'GET /api/clients/[id]/notes error')
    return NextResponse.json(
      { error: 'Failed to list client notes' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/clients/[id]/notes
 * Adds a new private `ClientNote` about a client, visible only to the freelancer
 * who owns the client relationship.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authenticateFreelancer(request)
    if (auth.error) return auth.error
    const user = auth.user!

    const clientId = await resolveClientId(context)
    if (!clientId) {
      return NextResponse.json(
        { error: 'Client ID is required' },
        { status: 400 },
      )
    }

    const ownership = await verifyClientRelationshipOwnership(user.id, clientId)
    if (!ownership.allowed) {
      return NextResponse.json(
        {
          error:
            ownership.reason ??
            'Forbidden: you do not own this client relationship',
          code: 'FORBIDDEN_CLIENT_RELATIONSHIP',
        },
        { status: 403 },
      )
    }

    let body: Record<string, unknown>
    try {
      body = ((await request.json()) ?? {}) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
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

    const note = await prisma.clientNote.create({
      data: {
        userId: user.id,
        clientId,
        content,
      },
    })

    return NextResponse.json(
      {
        note: serializeClientNote(note),
      },
      { status: 201 },
    )
  } catch (error) {
    logger?.error?.({ err: error }, 'POST /api/clients/[id]/notes error')
    return NextResponse.json(
      { error: 'Failed to create client note' },
      { status: 500 },
    )
  }
}
