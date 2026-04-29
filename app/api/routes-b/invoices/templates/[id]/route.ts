import { withRequestId } from '../../../_lib/with-request-id'
/**
 * GET    /api/routes-b/invoices/templates/[id]  - get a template
 * PATCH  /api/routes-b/invoices/templates/[id]  - update a template
 * DELETE /api/routes-b/invoices/templates/[id]  - delete a template
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getTemplateStore } from '../route'

const VALID_CADENCES = ['weekly', 'monthly', 'quarterly'] as const

async function resolveUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId } })
}

function serialize(t: ReturnType<typeof getTemplateStore>['values'] extends IterableIterator<infer V> ? V : never) {
  return { ...t, nextRunAt: t.nextRunAt.toISOString(), createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString() }
}

async function GETHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const user = await resolveUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const tpl = getTemplateStore().get(id)
  if (!tpl || tpl.userId !== user.id) {
    return NextResponse.json({ error: 'Template not found' }, { status: 404 })
  }

  return NextResponse.json({ template: serialize(tpl) })
}

async function PATCHHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const user = await resolveUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const tpl = getTemplateStore().get(id)
  if (!tpl || tpl.userId !== user.id) {
    return NextResponse.json({ error: 'Template not found' }, { status: 404 })
  }

  let body: Record<string, unknown>
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 })
    }
    tpl.name = body.name.trim()
  }
  if (body.amount !== undefined) {
    const a = Number(body.amount)
    if (!Number.isFinite(a) || a <= 0) {
      return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 })
    }
    tpl.amount = a
  }
  if (body.currency !== undefined) {
    tpl.currency = String(body.currency).toUpperCase()
  }
  if (body.cadence !== undefined) {
    if (!(VALID_CADENCES as readonly unknown[]).includes(body.cadence)) {
      return NextResponse.json({ error: `cadence must be one of: ${VALID_CADENCES.join(', ')}` }, { status: 400 })
    }
    tpl.cadence = body.cadence as typeof tpl.cadence
  }
  if (body.nextRunAt !== undefined) {
    const d = new Date(body.nextRunAt as string)
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: 'nextRunAt must be a valid ISO datetime' }, { status: 400 })
    }
    tpl.nextRunAt = d
  }

  tpl.updatedAt = new Date()
  return NextResponse.json({ template: serialize(tpl) })
}

async function DELETEHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const user = await resolveUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const tpl = getTemplateStore().get(id)
  if (!tpl || tpl.userId !== user.id) {
    return NextResponse.json({ error: 'Template not found' }, { status: 404 })
  }

  getTemplateStore().delete(id)
  return new NextResponse(null, { status: 204 })
}

export const GET = withRequestId(GETHandler)
export const PATCH = withRequestId(PATCHHandler)
export const DELETE = withRequestId(DELETEHandler)
