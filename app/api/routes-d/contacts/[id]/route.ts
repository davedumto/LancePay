import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

type ContactDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getContactDelegate(): ContactDelegate {
  return (prisma as unknown as { contact: ContactDelegate }).contact
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')

  if (!claims) {
    return null
  }

  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const user = await getAuthenticatedUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const contactDelegate = getContactDelegate()
  const contact = await contactDelegate.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      name: true,
      email: true,
      company: true,
      notes: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  if (!contact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
  }

  if (contact.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  return NextResponse.json({
    contact: {
      id: contact.id,
      name: contact.name,
      email: contact.email,
      company: contact.company ?? null,
      notes: contact.notes ?? null,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
    },
  })
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normalizeOptionalString(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') return undefined

  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length > maxLength) return undefined

  return trimmed
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = await getAuthenticatedUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const contactDelegate = getContactDelegate()
  const existingContact = await contactDelegate.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      name: true,
      email: true,
      company: true,
      notes: true,
      updatedAt: true,
    },
  })

  if (!existingContact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
  }

  if (existingContact.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const data: Record<string, unknown> = {}

  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    const name = normalizeOptionalString(body?.name, 100)
    if (!name) {
      return NextResponse.json(
        { error: 'Name must be a non-empty string with at most 100 characters' },
        { status: 400 },
      )
    }
    data.name = name
  }

  if (Object.prototype.hasOwnProperty.call(body, 'email')) {
    if (typeof body?.email !== 'string') {
      return NextResponse.json({ error: 'Email must be a valid email address' }, { status: 400 })
    }

    const email = body.email.trim().toLowerCase()
    if (!EMAIL_REGEX.test(email)) {
      return NextResponse.json({ error: 'Email must be a valid email address' }, { status: 400 })
    }

    if (email !== existingContact.email) {
      const duplicateContact = await contactDelegate.findFirst({
        where: {
          userId: user.id,
          email,
          id: { not: existingContact.id },
        },
        select: { id: true },
      })

      if (duplicateContact) {
        return NextResponse.json(
          { error: 'A contact with this email already exists' },
          { status: 409 },
        )
      }
    }

    data.email = email
  }

  if (Object.prototype.hasOwnProperty.call(body, 'company')) {
    const company = normalizeOptionalString(body?.company, 100)
    if (company === undefined && body?.company !== null) {
      return NextResponse.json(
        { error: 'Company must be at most 100 characters' },
        { status: 400 },
      )
    }
    data.company = company ?? null
  }

  if (Object.prototype.hasOwnProperty.call(body, 'notes')) {
    const notes = normalizeOptionalString(body?.notes, 500)
    if (notes === undefined && body?.notes !== null) {
      return NextResponse.json(
        { error: 'Notes must be at most 500 characters' },
        { status: 400 },
      )
    }
    data.notes = notes ?? null
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({
      contact: {
        id: existingContact.id,
        name: existingContact.name,
        email: existingContact.email,
        company: existingContact.company ?? null,
        notes: existingContact.notes ?? null,
        updatedAt: existingContact.updatedAt,
      },
    })
  }

  const updatedContact = await contactDelegate.update({
    where: { id },
    data,
    select: {
      id: true,
      name: true,
      email: true,
      company: true,
      notes: true,
      updatedAt: true,
    },
  })

  return NextResponse.json({
    contact: {
      id: updatedContact.id,
      name: updatedContact.name,
      email: updatedContact.email,
      company: updatedContact.company ?? null,
      notes: updatedContact.notes ?? null,
      updatedAt: updatedContact.updatedAt,
    },
  })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = await getAuthenticatedUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const contactDelegate = getContactDelegate()
  const contact = await contactDelegate.findUnique({
    where: { id },
    select: { id: true, userId: true },
  })

  if (!contact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
  }

  if (contact.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  await contactDelegate.delete({ where: { id } })

  return new NextResponse(null, { status: 204 })
}
