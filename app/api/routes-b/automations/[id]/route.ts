import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const MAX_NAME_LENGTH = 100
const VALID_TRIGGERS = ['invoice_paid', 'invoice_overdue', 'payment_received', 'client_added']
const VALID_ACTIONS = ['send_email', 'send_notification', 'tag_client', 'create_task']

type AutomationRuleDelegate = {
  findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getAutomationRuleDelegate(): AutomationRuleDelegate {
  return (prisma as unknown as { automationRule: AutomationRuleDelegate }).automationRule
}

async function getAuthenticatedUserId(request: NextRequest): Promise<string | null> {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
  return user ? user.id : null
}

const SELECT_FIELDS = {
  id: true,
  name: true,
  trigger: true,
  action: true,
  config: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
}

export async function GET(
  request: NextRequest,
  { params }: any,
) {
  const userId = await getAuthenticatedUserId(request)
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const ruleId = (await params).
  if (!ruleId || !ruleId.trim()) {
    return NextResponse.json({ error: 'Automation rule id is required' }, { status: 400 })
  }

  const delegate = getAutomationRuleDelegate()
  const rule = await delegate.findFirst({
    where: { id: ruleId, userId },
    select: SELECT_FIELDS,
  })

  if (!rule) {
    return NextResponse.json({ error: 'Automation rule not found' }, { status: 404 })
  }

  return NextResponse.json({ rule })
}

export async function PATCH(
  request: NextRequest,
  { params }: any,
) {
  const userId = await getAuthenticatedUserId(request)
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const ruleId = (await params).
  if (!ruleId || !ruleId.trim()) {
    return NextResponse.json({ error: 'Automation rule id is required' }, { status: 400 })
  }

  const delegate = getAutomationRuleDelegate()
  const existing = await delegate.findFirst({
    where: { id: ruleId, userId },
    select: { id: true },
  })

  if (!existing) {
    return NextResponse.json({ error: 'Automation rule not found' }, { status: 404 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const payload = (body ?? {}) as Record<string, unknown>
  const data: Record<string, unknown> = {}

  if (payload.name !== undefined) {
    const name = typeof payload.name === 'string' ? payload.name.trim() : null
    if (!name) {
      return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 })
    }
    if (name.length > MAX_NAME_LENGTH) {
      return NextResponse.json(
        { error: `name must be at most ${MAX_NAME_LENGTH} characters` },
        { status: 400 },
      )
    }
    data.name = name
  }

  if (payload.trigger !== undefined) {
    if (typeof payload.trigger !== 'string' || !VALID_TRIGGERS.includes(payload.trigger)) {
      return NextResponse.json(
        { error: `trigger must be one of: ${VALID_TRIGGERS.join(', ')}` },
        { status: 400 },
      )
    }
    data.trigger = payload.trigger
  }

  if (payload.action !== undefined) {
    if (typeof payload.action !== 'string' || !VALID_ACTIONS.includes(payload.action)) {
      return NextResponse.json(
        { error: `action must be one of: ${VALID_ACTIONS.join(', ')}` },
        { status: 400 },
      )
    }
    data.action = payload.action
  }

  if (payload.config !== undefined) {
    if (typeof payload.config !== 'object' || payload.config === null || Array.isArray(payload.config)) {
      return NextResponse.json({ error: 'config must be an object' }, { status: 400 })
    }
    data.config = payload.config
  }

  if (payload.isActive !== undefined) {
    data.isActive = Boolean(payload.isActive)
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  const updated = await delegate.update({
    where: { id: ruleId },
    data,
    select: SELECT_FIELDS,
  })

  return NextResponse.json({ rule: updated })
}

export async function DELETE(
  request: NextRequest,
  { params }: any,
) {
  const userId = await getAuthenticatedUserId(request)
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const ruleId = (await params).
  if (!ruleId || !ruleId.trim()) {
    return NextResponse.json({ error: 'Automation rule id is required' }, { status: 400 })
  }

  const delegate = getAutomationRuleDelegate()
  const existing = await delegate.findFirst({
    where: { id: ruleId, userId },
    select: { id: true },
  })

  if (!existing) {
    return NextResponse.json({ error: 'Automation rule not found' }, { status: 404 })
  }

  await delegate.delete({ where: { id: ruleId } })

  return new NextResponse(null, { status: 204 })
}
