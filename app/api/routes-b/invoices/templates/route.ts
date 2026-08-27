import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// GET  /api/routes-b/invoices/templates — list the authenticated user's invoice templates.
// POST /api/routes-b/invoices/templates — create a new invoice template.

const SELECT_FIELDS = {
  id: true,
  name: true,
  clientEmail: true,
  clientName: true,
  description: true,
  amount: true,
  currency: true,
  createdAt: true,
  updatedAt: true,
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

function serializeTemplate(template: {
  id: string
  name: string
  clientEmail: string | null
  clientName: string | null
  description: string
  amount: { toString(): string }
  currency: string
  createdAt: Date
  updatedAt: Date
}) {
  return {
    ...template,
    amount: Number(template.amount),
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const templates = await prisma.invoiceTemplate.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: SELECT_FIELDS,
    })

    return NextResponse.json({ templates: templates.map(serializeTemplate) })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/invoices/templates error')
    return NextResponse.json({ error: 'Failed to fetch invoice templates' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as Record<string, unknown>
    const { name, clientEmail, clientName, description, amount, currency = 'USD' } = payload

    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }
    if (typeof description !== 'string' || !description.trim()) {
      return NextResponse.json({ error: 'description is required' }, { status: 400 })
    }

    const parsedAmount = Number(amount)
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 })
    }

    if (clientEmail !== undefined && clientEmail !== null && typeof clientEmail !== 'string') {
      return NextResponse.json({ error: 'clientEmail must be a string' }, { status: 400 })
    }

    const existing = await prisma.invoiceTemplate.findUnique({
      where: { userId_name: { userId: user.id, name: name.trim() } },
      select: { id: true },
    })
    if (existing) {
      return NextResponse.json(
        { error: 'A template with this name already exists' },
        { status: 409 },
      )
    }

    const template = await prisma.invoiceTemplate.create({
      data: {
        userId: user.id,
        name: name.trim(),
        clientEmail: (clientEmail as string | undefined)?.toLowerCase() || null,
        clientName: (clientName as string | undefined) || null,
        description: description.trim(),
        amount: parsedAmount,
        currency: typeof currency === 'string' ? currency : 'USD',
      },
      select: SELECT_FIELDS,
    })

    return NextResponse.json({ template: serializeTemplate(template) }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/invoices/templates error')
    return NextResponse.json({ error: 'Failed to create invoice template' }, { status: 500 })
  }
}
