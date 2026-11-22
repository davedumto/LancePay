import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const DEFAULT_PAGE_SIZE = 20
const MAX_LIMIT = 100
const MAX_NAME_LENGTH = 255
const MAX_EMAIL_LENGTH = 255
const MAX_PHONE_LENGTH = 20
const MAX_COMPANY_LENGTH = 100
const MAX_NOTES_LENGTH = 1000
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const contactSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  company: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} as const

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId } })
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * GET /api/contacts
 * Lists the caller's contacts, newest first. Soft-deleted contacts are excluded.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { searchParams } = new URL(request.url)
    const page = parsePositiveInt(searchParams.get('page'), 1)
    const limit = Math.min(MAX_LIMIT, parsePositiveInt(searchParams.get('limit'), DEFAULT_PAGE_SIZE))

    const where = { userId: user.id, deletedAt: null }

    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: contactSelect,
      }),
      prisma.contact.count({ where }),
    ])

    return NextResponse.json({ contacts, total, page, limit })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/contacts error')
    return NextResponse.json({ error: 'Failed to fetch contacts' }, { status: 500 })
  }
}

type OptionalTextResult = { value: string | null } | { error: string }

function readOptionalText(payload: Record<string, unknown>, field: string, max: number): OptionalTextResult {
  const raw = payload[field]
  if (raw === undefined || raw === null) return { value: null }
  if (typeof raw !== 'string') return { error: `${field} must be a string` }
  const value = raw.trim()
  if (value.length > max) return { error: `${field} must be at most ${max} characters` }
  return { value: value || null }
}

/**
 * POST /api/contacts
 * Creates a contact for the caller.
 *
 * `Contact` has a database-level unique (userId, email) constraint that also
 * covers soft-deleted rows. A soft-deleted contact therefore must not block
 * reusing its email, so when one exists it is restored with the new details
 * instead of inserting a second row. An active contact with the same email is
 * a 409.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
    }
    const payload = body as Record<string, unknown>

    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
    if (name.length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `name must be at most ${MAX_NAME_LENGTH} characters` }, { status: 400 })
    }

    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
    if (!email) return NextResponse.json({ error: 'email is required' }, { status: 400 })
    if (email.length > MAX_EMAIL_LENGTH) {
      return NextResponse.json({ error: `email must be at most ${MAX_EMAIL_LENGTH} characters` }, { status: 400 })
    }
    if (!EMAIL_PATTERN.test(email)) {
      return NextResponse.json({ error: 'email must be a valid email address' }, { status: 400 })
    }

    const phone = readOptionalText(payload, 'phone', MAX_PHONE_LENGTH)
    if ('error' in phone) return NextResponse.json({ error: phone.error }, { status: 400 })
    const company = readOptionalText(payload, 'company', MAX_COMPANY_LENGTH)
    if ('error' in company) return NextResponse.json({ error: company.error }, { status: 400 })
    const notes = readOptionalText(payload, 'notes', MAX_NOTES_LENGTH)
    if ('error' in notes) return NextResponse.json({ error: notes.error }, { status: 400 })

    const details = { name, phone: phone.value, company: company.value, notes: notes.value }
    const conflict = () =>
      NextResponse.json({ error: 'A contact with this email already exists' }, { status: 409 })

    try {
      const existing = await prisma.contact.findFirst({
        where: { userId: user.id, email },
        select: { id: true, deletedAt: true },
      })

      if (existing && existing.deletedAt === null) return conflict()

      const contact = existing
        ? await prisma.contact.update({
            where: { id: existing.id },
            data: { ...details, deletedAt: null },
            select: contactSelect,
          })
        : await prisma.contact.create({
            data: { userId: user.id, email, ...details },
            select: contactSelect,
          })

      return NextResponse.json({ contact }, { status: 201 })
    } catch (error) {
      // A concurrent request created the same email between our check and write.
      if (isUniqueConstraintError(error)) return conflict()
      throw error
    }
  } catch (error) {
    logger.error({ err: error }, 'POST /api/contacts error')
    return NextResponse.json({ error: 'Failed to create contact' }, { status: 500 })
  }
}
