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

async function GETHandler(request: NextRequest, { params }: { params: { id: string } }) {
  let contactId: string | undefined

  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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

async function PATCHHandler(request: NextRequest, { params }: { params: { id: string } }) {
  let contactId: string | undefined

  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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

    const body = await request.json()

    const updated = await prisma.contact.update({
      where: { id },
      data: {
        name: typeof body.name === 'string' ? body.name.trim() : undefined,
        email: typeof body.email === 'string' ? body.email.trim().toLowerCase() : undefined,
        company: typeof body.company === 'string' ? body.company.trim() : null,
        notes: typeof body.notes === 'string' ? body.notes.trim() : null,
      },
      select: { id: true, name: true, email: true, updatedAt: true },
    })

    return NextResponse.json({ contact: updated }, { status: 200 })
  } catch (error) {
    logger.error({ err: error, contactId }, 'PATCH contact error')
    return NextResponse.json({ error: 'Failed to update contact' }, { status: 500 })
  }
}

async function DELETEHandler(request: NextRequest, { params }: { params: { id: string } }) {
  let contactId: string | undefined

  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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