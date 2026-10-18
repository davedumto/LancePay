import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

async function resolveContactId(context?: RouteContext): Promise<string> {
  if (!context?.params) return ''
  const resolved = await Promise.resolve(context.params)
  return (resolved?.id ?? '').trim()
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

function serializeContact(contact: Record<string, any>) {
  return {
    id: contact.id,
    userId: contact.userId,
    name: contact.name,
    email: contact.email,
    phone: contact.phone ?? null,
    company: contact.company ?? null,
    notes: contact.notes ?? null,
    createdAt: contact.createdAt
      ? new Date(contact.createdAt).toISOString()
      : null,
    updatedAt: contact.updatedAt
      ? new Date(contact.updatedAt).toISOString()
      : null,
    deletedAt: contact.deletedAt
      ? new Date(contact.deletedAt).toISOString()
      : null,
  }
}

/**
 * GET /api/contacts/[id]
 * Fetches a single active (non-soft-deleted) contact owned by the authenticated user.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const contactId = await resolveContactId(context)
    if (!contactId) {
      return NextResponse.json(
        { error: 'Contact ID is required' },
        { status: 400 },
      )
    }

    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    const contact =
      typeof prisma.contact?.findUnique === 'function'
        ? await prisma.contact.findUnique({ where: { id: contactId } })
        : await prisma.contact.findFirst({ where: { id: contactId } })

    if (!contact || contact.deletedAt) {
      return NextResponse.json(
        { error: 'Contact not found', code: 'CONTACT_NOT_FOUND' },
        { status: 404 },
      )
    }

    if (contact.userId !== user.id) {
      return NextResponse.json(
        {
          error: 'Forbidden: you do not own this contact',
          code: 'FORBIDDEN_CONTACT_OWNER',
        },
        { status: 403 },
      )
    }

    return NextResponse.json({
      contact: serializeContact(contact),
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'GET /api/contacts/[id] error')
    return NextResponse.json(
      { error: 'Failed to fetch contact' },
      { status: 500 },
    )
  }
}

/**
 * DELETE /api/contacts/[id]
 * Soft-deletes a `Contact` by setting `deletedAt` instead of performing a hard delete:
 * - Preserves the row for historical invoice references.
 * - Rejects deleting a contact that is already soft-deleted (`deletedAt !== null`), returning `404`.
 * - Only the owning user may delete their own contact (`403`).
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const contactId = await resolveContactId(context)
    if (!contactId) {
      return NextResponse.json(
        { error: 'Contact ID is required' },
        { status: 400 },
      )
    }

    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    const contact =
      typeof prisma.contact?.findUnique === 'function'
        ? await prisma.contact.findUnique({ where: { id: contactId } })
        : await prisma.contact.findFirst({ where: { id: contactId } })

    if (!contact || contact.deletedAt !== null && contact.deletedAt !== undefined) {
      return NextResponse.json(
        { error: 'Contact not found', code: 'CONTACT_NOT_FOUND' },
        { status: 404 },
      )
    }

    if (contact.userId !== user.id) {
      return NextResponse.json(
        {
          error: 'Forbidden: only the owning user may delete their contact',
          code: 'FORBIDDEN_CONTACT_OWNER',
        },
        { status: 403 },
      )
    }

    const now = new Date()
    const softDeleted = await prisma.contact.update({
      where: { id: contactId },
      data: {
        deletedAt: now,
      },
    })

    return NextResponse.json({
      deleted: true,
      contact: serializeContact(softDeleted),
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'DELETE /api/contacts/[id] error')
    return NextResponse.json(
      { error: 'Failed to delete contact' },
      { status: 500 },
    )
  }
}
