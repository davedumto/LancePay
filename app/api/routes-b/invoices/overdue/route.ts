import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import {
  findContactById,
  softDeleteContact,
  supportsContactSoftDelete,
} from '../../_lib/contacts'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null

  const claims = await verifyAuthToken(authToken)
  if (!claims) return null

  return prisma.user.findUnique({
    where: { privyId: claims.userId },
  })
}

async function GETHandler(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  let contactId: string | undefined

  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = params
    contactId = id

    const contact = await findContactById({
      id,
      userId: user.id,
      includeDeleted: false,
    })

    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    return NextResponse.json({ contact }, { status: 200 })
  } catch (error) {
    logger.error({ err: error, contactId }, 'GET contact error')
    return NextResponse.json({ error: 'Failed to fetch contact' }, { status: 500 })
  }
}

async function PATCHHandler(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  let contactId: string | undefined

  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = params
    contactId = id

    const contact = await findContactById({
      id,
      userId: user.id,
      includeDeleted: false,
    })

    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    let body: {
      name?: unknown
      email?: unknown
      company?: unknown
      notes?: unknown
    }

    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const updateData: {
      name?: string
      email?: string
      company?: string | null
      notes?: string | null
    } = {}

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        return NextResponse.json({ error: 'Invalid name' }, { status: 400 })
      }
      updateData.name = body.name.trim()
    }

    if (body.email !== undefined) {
      if (typeof body.email !== 'string') {
        return NextResponse.json({ error: 'Invalid email' }, { status: 400 })
      }

      const email = body.email.trim().toLowerCase()
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)

      if (!ok) {
        return NextResponse.json({ error: 'Invalid email format' }, { status: 400 })
      }

      updateData.email = email
    }

    if (body.company !== undefined) {
      updateData.company =
        typeof body.company === 'string' ? body.company.trim() : null
    }

    if (body.notes !== undefined) {
      updateData.notes =
        typeof body.notes === 'string' ? body.notes.trim() : null
    }

    const updated = await prisma.contact.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ contact: updated }, { status: 200 })
  } catch (error) {
    logger.error({ err: error, contactId }, 'PATCH contact error')
    return NextResponse.json({ error: 'Failed to update contact' }, { status: 500 })
  }
}

async function DELETEHandler(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  let contactId: string | undefined

  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = params
    contactId = id

    const supported = await supportsContactSoftDelete()
    if (!supported) {
      return NextResponse.json(
        { error: 'Soft delete not supported' },
        { status: 409 }
      )
    }

    const deleted = await softDeleteContact({
      id,
      userId: user.id,
    })

    if (!deleted) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    return NextResponse.json({ contact: deleted }, { status: 200 })
  } catch (error) {
    logger.error({ err: error, contactId }, 'DELETE contact error')
    return NextResponse.json({ error: 'Failed to delete contact' }, { status: 500 })
  }
}

export const GET = withRequestId(GETHandler)
export const PATCH = withRequestId(PATCHHandler)
export const DELETE = withRequestId(DELETEHandler)