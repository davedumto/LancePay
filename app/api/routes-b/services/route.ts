import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const MAX_NAME_LENGTH = 100
const MAX_DESCRIPTION_LENGTH = 500
const MAX_RATE_USDC = 1_000_000
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

// ServiceCatalogItem is not yet in the Prisma schema, so we access it
// via a cast. Once the model is migrated this cast can be removed.
type ServiceDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
  count: (args: Record<string, unknown>) => Promise<number>
  create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getServiceDelegate(): ServiceDelegate {
  return (prisma as unknown as { serviceCatalogItem: ServiceDelegate }).serviceCatalogItem
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

function parsePage(raw: string | null): number {
  if (!raw) return 1
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 1 ? n : 1
}

function parsePageSize(raw: string | null): number {
  if (!raw) return DEFAULT_PAGE_SIZE
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE
  return Math.min(n, MAX_PAGE_SIZE)
}

function parseRate(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > MAX_RATE_USDC) return null
    return value.toString()
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null
    const num = Number.parseFloat(trimmed)
    if (!Number.isFinite(num) || num < 0 || num > MAX_RATE_USDC) return null
    return trimmed
  }
  return null
}

export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = request.nextUrl
  const page = parsePage(url.searchParams.get('page'))
  const pageSize = parsePageSize(url.searchParams.get('pageSize'))

  const where = { userId: user.id }
  const delegate = getServiceDelegate()

  const [items, totalCount] = await Promise.all([
    delegate.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, name: true, description: true, rateUsdc: true, currency: true, unit: true, isActive: true, createdAt: true, updatedAt: true },
    }),
    delegate.count({ where }),
  ])

  return NextResponse.json({
    items,
    pagination: {
      page,
      pageSize,
      totalCount,
      totalPages: Math.ceil(totalCount / pageSize),
    },
  })
}

export async function POST(request: NextRequest) {
  const user = await getAuthenticatedUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const payload = (body ?? {}) as Record<string, unknown>

  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  if (!name || name.length > MAX_NAME_LENGTH) {
    return NextResponse.json(
      { error: `name is required and must be at most ${MAX_NAME_LENGTH} characters.` },
      { status: 400 },
    )
  }

  const description =
    typeof payload.description === 'string' ? payload.description.trim() : null
  if (description !== null && description.length > MAX_DESCRIPTION_LENGTH) {
    return NextResponse.json(
      { error: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters.` },
      { status: 400 },
    )
  }

  const rateUsdc = parseRate(payload.rateUsdc)
  if (rateUsdc === null) {
    return NextResponse.json(
      { error: `rateUsdc must be a non-negative number up to ${MAX_RATE_USDC}.` },
      { status: 400 },
    )
  }

  const currency =
    typeof payload.currency === 'string' && /^[A-Z]{3}$/.test(payload.currency.trim().toUpperCase())
      ? payload.currency.trim().toUpperCase()
      : 'USD'

  const unit =
    typeof payload.unit === 'string' && payload.unit.trim().length > 0
      ? payload.unit.trim().slice(0, 30)
      : 'hour'

  const delegate = getServiceDelegate()
  const created = await delegate.create({
    data: { userId: user.id, name, description, rateUsdc, currency, unit, isActive: true },
    select: { id: true, name: true, description: true, rateUsdc: true, currency: true, unit: true, isActive: true, createdAt: true, updatedAt: true },
  })

  return NextResponse.json(created, { status: 201 })
}
