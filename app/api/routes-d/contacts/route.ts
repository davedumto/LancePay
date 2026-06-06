import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { z } from 'zod'

const contactSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email('Invalid email format'),
  phone: z.string().regex(/^[+]?[\d\s\-()]{10,}$/, 'Invalid phone format').optional().nullable(),
  company: z.string().max(100).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
})

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
  // An omitted optional field is treated as "no value" (null), not invalid input.
  // `undefined` is reserved for values that fail validation (wrong type or too long).
  if (value === undefined) return null
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
              { phone: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
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
      phone: contact.phone ?? null,
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

  // Validate using Zod schema
  const validationResult = contactSchema.safeParse(body)
  if (!validationResult.success) {
    return NextResponse.json(
      {
        error: 'Validation failed',
        details: validationResult.error.errors,
      },
      { status: 400 },
    )
  }

  const { name, email, phone, company, notes } = validationResult.data

  const contactDelegate = getContactDelegate()

  try {
    const contact = await contactDelegate.create({
      data: {
        userId: user.id,
        name: name.trim(),
        email: email.trim().toLowerCase(),
        phone: phone?.trim() || null,
        company: company?.trim() || null,
        notes: notes?.trim() || null,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
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
        phone: contact.phone ?? null,
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
