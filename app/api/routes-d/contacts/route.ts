import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type ContactDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
  create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
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

function normalizeOptionalString(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') return undefined

  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > maxLength) return undefined

  return trimmed
}

export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const search = request.nextUrl.searchParams.get('search')?.trim() || ''
  const contactDelegate = getContactDelegate()

  const contacts = await contactDelegate.findMany({
    where: {
      userId: user.id,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      email: true,
      company: true,
      notes: true,
      createdAt: true,
    },
  })

  return NextResponse.json({
    contacts: contacts.map((contact) => ({
      id: contact.id,
      name: contact.name,
      email: contact.email,
      company: contact.company ?? null,
      notes: contact.notes ?? null,
      createdAt: contact.createdAt,
    })),
  })
}

export async function POST(request: NextRequest) {
  const user = await getAuthenticatedUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const company = normalizeOptionalString(body?.company, 100)
  const notes = normalizeOptionalString(body?.notes, 500)

  if (!name || name.length > 100) {
    return NextResponse.json({ error: 'Name is required and must be at most 100 characters' }, { status: 400 })
  }

  if (!email || !EMAIL_REGEX.test(email)) {
    return NextResponse.json({ error: 'A valid email is required' }, { status: 400 })
  }

  if (company === undefined) {
    return NextResponse.json({ error: 'Company must be at most 100 characters' }, { status: 400 })
  }

  if (notes === undefined) {
    return NextResponse.json({ error: 'Notes must be at most 500 characters' }, { status: 400 })
  }

  const contactDelegate = getContactDelegate()

  try {
    const contact = await contactDelegate.create({
      data: {
        userId: user.id,
        name,
        email,
        company,
        notes,
      },
      select: {
        id: true,
        name: true,
        email: true,
        company: true,
        notes: true,
        createdAt: true,
      },
    })

    return NextResponse.json(
      {
        id: contact.id,
        name: contact.name,
        email: contact.email,
        company: contact.company ?? null,
        notes: contact.notes ?? null,
        createdAt: contact.createdAt,
      },
      { status: 201 },
    )
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    ) {
      return NextResponse.json(
        { error: 'A contact with this email already exists' },
        { status: 409 },
      )
    }

    throw error
  }
}
