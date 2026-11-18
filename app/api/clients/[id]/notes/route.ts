import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const createNoteSchema = z
  .object({
    content: z.string().trim().min(1, 'Content is required'),
  })
  .strict()

const paginationSchema = z.object({
  page: z.string().regex(/^\d+$/).transform(Number).optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).optional(),
})

type CreateNoteInput = z.infer<typeof createNoteSchema>

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
 * GET /api/clients/[id]/notes
 * Returns notes for a client, paginated and ordered by createdAt descending
 * Only the freelancer who owns the client relationship can access
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const clientId = params.id
    if (!clientId) {
      return NextResponse.json({ error: 'Client ID is required' }, { status: 400 })
    }

    // Verify the freelancer owns the client relationship
    const client = await prisma.user.findUnique({
      where: { id: clientId },
      select: { id: true },
    })

    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    // Check if there's any note from the authenticated user for this client
    // This verifies the user has a relationship with this client
    const userHasRelationship = await prisma.clientNote.count({
      where: { userId: user.id, clientId },
    })

    if (userHasRelationship === 0) {
      // Also check if there are any invoices between them to verify relationship
      const invoiceExists = await prisma.invoice.count({
        where: {
          OR: [
            { userId: user.id, clientId },
            { clientId: user.id, userId: clientId },
          ],
        },
      })

      if (invoiceExists === 0) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    const { searchParams } = new URL(request.url)
    const pageParsed = paginationSchema.safeParse({
      page: searchParams.get('page'),
      limit: searchParams.get('limit'),
    })

    if (!pageParsed.success) {
      return NextResponse.json({ error: 'Invalid pagination parameters' }, { status: 400 })
    }

    const page = pageParsed.data.page ?? 1
    const limit = Math.min(pageParsed.data.limit ?? 50, 100)
    const skip = (page - 1) * limit

    const [notes, total] = await Promise.all([
      prisma.clientNote.findMany({
        where: {
          userId: user.id,
          clientId,
        },
        select: { id: true, content: true, createdAt: true, updatedAt: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.clientNote.count({
        where: {
          userId: user.id,
          clientId,
        },
      }),
    ])

    return NextResponse.json({
      notes,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/clients/[id]/notes error')
    return NextResponse.json({ error: 'Failed to fetch notes' }, { status: 500 })
  }
}

/**
 * POST /api/clients/[id]/notes
 * Creates a new note about a client
 * Only the freelancer who owns the client relationship can create notes
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const clientId = params.id
    if (!clientId) {
      return NextResponse.json({ error: 'Client ID is required' }, { status: 400 })
    }

    let body: unknown = {}
    const rawBody = await request.text()
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody)
      } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
      }
    }

    const parsed = createNoteSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }

    // Verify the client exists
    const client = await prisma.user.findUnique({
      where: { id: clientId },
      select: { id: true },
    })

    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    // Verify the freelancer has a relationship with this client via invoices
    const invoiceExists = await prisma.invoice.count({
      where: {
        OR: [
          { userId: user.id, clientId },
          { clientId: user.id, userId: clientId },
        ],
      },
    })

    if (invoiceExists === 0) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const note = await prisma.clientNote.create({
      data: {
        userId: user.id,
        clientId,
        content: parsed.data.content,
      },
      select: { id: true, content: true, createdAt: true, updatedAt: true },
    })

    logger.info({ userId: user.id, clientId, noteId: note.id }, 'Client note created')

    return NextResponse.json({ note }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/clients/[id]/notes error')
    return NextResponse.json({ error: 'Failed to create note' }, { status: 500 })
  }
}
