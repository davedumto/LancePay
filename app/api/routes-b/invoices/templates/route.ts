/**
 * GET  /api/routes-b/invoices/templates  - list templates for user
 * POST /api/routes-b/invoices/templates  - create a template
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const VALID_CADENCES = ['weekly', 'monthly', 'quarterly'] as const
type Cadence = (typeof VALID_CADENCES)[number]

async function resolveUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId } })
}

// In-memory template store (user-scoped)
// Shape: { id, userId, name, clientId, amount, currency, cadence, nextRunAt, createdAt, updatedAt }
export interface InvoiceTemplate {
  id: string
  userId: string
  name: string
  clientId: string
  amount: number
  currency: string
  cadence: Cadence
  nextRunAt: Date
  createdAt: Date
  updatedAt: Date
}

let seq = 0
const templates = new Map<string, InvoiceTemplate>()

export function getTemplateStore() { return templates }
export function clearTemplateStore() { templates.clear(); seq = 0 }

function newId() { return `tpl_${++seq}_${Date.now()}` }

export async function GET(request: NextRequest) {
  const user = await resolveUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userTemplates = [...templates.values()].filter((t) => t.userId === user.id)
  return NextResponse.json({ templates: userTemplates.map(serialize) })
}

export async function POST(request: NextRequest) {
  const user = await resolveUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { name, clientId, amount, currency = 'USD', cadence, nextRunAt } = body as Record<string, unknown>

  if (!name || typeof name !== 'string' || name.trim() === '') {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  if (!clientId || typeof clientId !== 'string') {
    return NextResponse.json({ error: 'clientId is required' }, { status: 400 })
  }
  const parsedAmount = Number(amount)
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 })
  }
  if (!cadence || !(VALID_CADENCES as readonly unknown[]).includes(cadence)) {
    return NextResponse.json(
      { error: `cadence must be one of: ${VALID_CADENCES.join(', ')}` },
      { status: 400 },
    )
  }
  if (!nextRunAt || typeof nextRunAt !== 'string') {
    return NextResponse.json({ error: 'nextRunAt is required' }, { status: 400 })
  }
  const nextRunAtDate = new Date(nextRunAt as string)
  if (Number.isNaN(nextRunAtDate.getTime())) {
    return NextResponse.json({ error: 'nextRunAt must be a valid ISO datetime' }, { status: 400 })
  }

  const now = new Date()
  const tpl: InvoiceTemplate = {
    id: newId(),
    userId: user.id,
    name: (name as string).trim(),
    clientId: clientId as string,
    amount: parsedAmount,
    currency: (currency as string).toUpperCase(),
    cadence: cadence as Cadence,
    nextRunAt: nextRunAtDate,
    createdAt: now,
    updatedAt: now,
  }
  templates.set(tpl.id, tpl)

  return NextResponse.json({ template: serialize(tpl) }, { status: 201 })
}

function serialize(t: InvoiceTemplate) {
  return { ...t, nextRunAt: t.nextRunAt.toISOString(), createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString() }
}
