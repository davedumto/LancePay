import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const MAX_NAME_LENGTH = 255
const MAX_EMAIL_LENGTH = 255
const MAX_PHONE_LENGTH = 20
const MAX_COMPANY_LENGTH = 100
const MAX_NOTES_LENGTH = 1000

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId } })
}

export async function GET(
  request: NextRequest,
  { params }: any
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const contact = await prisma.contact.findFirst({
      where: { id: (await params)., userId: user.id, deletedAt: null },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        company: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    return NextResponse.json({ contact })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/contacts/[id] error')
    return NextResponse.json({ error: 'Failed to fetch contact' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: any
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as Record<string, unknown>

    const contact = await prisma.contact.findFirst({
      where: { id: (await params)., userId: user.id, deletedAt: null },
    })

    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    const updateData: Record<string, unknown> = {}

    if ('name' in payload) {
      const name = typeof payload.name === 'string' ? payload.name.trim() : null
      if (!name) {
        return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
      }
      if (name.length > MAX_NAME_LENGTH) {
        return NextResponse.json(
          { error: `name must be at most ${MAX_NAME_LENGTH} characters` },
          { status: 400 }
        )
      }
      updateData.name = name
    }

    if ('email' in payload) {
      const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null
      if (!email) {
        return NextResponse.json({ error: 'email cannot be empty' }, { status: 400 })
      }
      if (email.length > MAX_EMAIL_LENGTH) {
        return NextResponse.json(
          { error: `email must be at most ${MAX_EMAIL_LENGTH} characters` },
          { status: 400 }
        )
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return NextResponse.json({ error: 'email must be a valid email address' }, { status: 400 })
      }
      updateData.email = email
    }

    if ('phone' in payload) {
      const phone = typeof payload.phone === 'string' ? payload.phone.trim() : null
      if (phone && phone.length > MAX_PHONE_LENGTH) {
        return NextResponse.json(
          { error: `phone must be at most ${MAX_PHONE_LENGTH} characters` },
          { status: 400 }
        )
      }
      updateData.phone = phone || null
    }

    if ('company' in payload) {
      const company = typeof payload.company === 'string' ? payload.company.trim() : null
      if (company && company.length > MAX_COMPANY_LENGTH) {
        return NextResponse.json(
          { error: `company must be at most ${MAX_COMPANY_LENGTH} characters` },
          { status: 400 }
        )
      }
      updateData.company = company || null
    }

    if ('notes' in payload) {
      const notes = typeof payload.notes === 'string' ? payload.notes.trim() : null
      if (notes && notes.length > MAX_NOTES_LENGTH) {
        return NextResponse.json(
          { error: `notes must be at most ${MAX_NOTES_LENGTH} characters` },
          { status: 400 }
        )
      }
      updateData.notes = notes || null
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
    }

    const updatedContact = await prisma.contact.update({
      where: { id: (await params). },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        company: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ contact: updatedContact })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/routes-b/contacts/[id] error')
    return NextResponse.json({ error: 'Failed to update contact' }, { status: 500 })
  }
}
