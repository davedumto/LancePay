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
  const authToken = request.headers
    .get('authorization')
    ?.replace('Bearer ', '')

  if (!authToken) return null

  const claims = await verifyAuthToken(authToken)
  if (!claims) return null

  return prisma.user.findUnique({
    where: { privyId: claims.userId },
  })
}

async function GETHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let contactId: string | undefined

  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    contactId = id

    const includeDeleted =
      new URL(request.url).searchParams.get('includeDeleted') === 'true'

    const contact = await findContactById({
      id,
      userId: user.id,
      includeDeleted,
    })

    if (!contact) {
      return NextResponse.json(
        { error: 'Contact not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({ contact }, { status: 200 })
  } catch (error) {
    logger.error({ err: error, contactId }, 'Routes B contact GET error')
    return NextResponse.json(
      { error: 'Failed to fetch contact' },
      { status: 500 }
    )
  }
}

async function PATCHHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let contactId: string | undefined

  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    contactId = id

    const contact = await findContactById({
      id,
      userId: user.id,
      includeDeleted: false,
    })

    if (!contact) {
      return NextResponse.json(
        { error: 'Contact not found' },
        { status: 404 }
      )
    }

    let body: any
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 }
      )
    }

    const updateData: Record<string, any> = {}

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        return NextResponse.json(
          { error: 'name must be a non-empty string' },
          { status: 400 }
        )
      }
      updateData.name = body.name.trim()
    }

    if (body.email !== undefined) {
      const email = body.email?.trim()?.toLowerCase()
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

      if (!email || !emailPattern.test(email)) {
        return NextResponse.json(
          { error: 'invalid email' },
          { status: 400 }
        )
      }

      const existing = await prisma.contact.findUnique({
        where: {
          userId_email: { userId: user.id, email },
        },
        select: { id: true },
      })

      if (existing && existing.id !== id) {
        return NextResponse.json(
          { error: 'Email already exists' },
          { status: 409 }
        )
      }

      updateData.email = email
    }

    const updatedContact = await prisma.contact.update({
      where: { id },
      data: updateData,
      select: { id: true, name: true, email: true, updatedAt: true },
    })

    return NextResponse.json({ contact: updatedContact }, { status: 200 })
  } catch (error) {
    logger.error({ err: error, contactId }, 'Routes B contact PATCH error')
    return NextResponse.json(
      { error: 'Failed to update contact' },
      { status: 500 }
    )
  }
}

async function DELETEHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let contactId: string | undefined

  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
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
      return NextResponse.json(
        { error: 'Contact not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({ contact: deleted }, { status: 200 })
  } catch (error) {
    logger.error({ err: error, contactId }, 'Routes B contact DELETE error')
    return NextResponse.json(
      { error: 'Failed to delete contact' },
      { status: 500 }
    )
  }
}

export const GET = withRequestId(GETHandler)
export const PATCH = withRequestId(PATCHHandler)
export const DELETE = withRequestId(DELETEHandler)