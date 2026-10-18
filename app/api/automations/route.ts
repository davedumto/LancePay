import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const MAX_AUTOMATION_NAME_LENGTH = 150

export const ALLOWED_TRIGGER_TYPES = [
  'invoice_paid',
  'invoice_overdue',
  'invoice_created',
  'payment_received',
  'client_added',
] as const

export const ALLOWED_ACTION_TYPES = [
  'send_email',
  'send_notification',
  'tag_client',
  'tag_invoice',
  'create_task',
  'send_webhook',
] as const

export type AutomationTriggerType = (typeof ALLOWED_TRIGGER_TYPES)[number]
export type AutomationActionType = (typeof ALLOWED_ACTION_TYPES)[number]

// Defines which action types are valid for each trigger type
export const SUPPORTED_TRIGGER_ACTIONS: Record<
  AutomationTriggerType,
  readonly AutomationActionType[]
> = {
  invoice_paid: [
    'send_email',
    'send_notification',
    'tag_client',
    'tag_invoice',
    'create_task',
    'send_webhook',
  ],
  invoice_overdue: [
    'send_email',
    'send_notification',
    'tag_client',
    'tag_invoice',
    'create_task',
    'send_webhook',
  ],
  invoice_created: [
    'send_email',
    'send_notification',
    'tag_invoice',
    'create_task',
    'send_webhook',
  ],
  payment_received: [
    'send_email',
    'send_notification',
    'tag_client',
    'tag_invoice',
    'create_task',
    'send_webhook',
  ],
  // client_added has no associated invoice, so tag_invoice is unsupported
  client_added: [
    'send_email',
    'send_notification',
    'tag_client',
    'create_task',
    'send_webhook',
  ],
}

export function validateAutomationConfig(
  triggerType: AutomationTriggerType,
  actionType: AutomationActionType,
  config: unknown,
): { valid: boolean; error?: string } {
  if (
    config === undefined ||
    config === null ||
    typeof config !== 'object' ||
    Array.isArray(config)
  ) {
    return {
      valid: false,
      error: 'config is required and must be a JSON object',
    }
  }

  const cfg = config as Record<string, unknown>

  // Trigger-specific config validation
  if (triggerType === 'invoice_overdue' && cfg.daysOverdue !== undefined) {
    const days = Number(cfg.daysOverdue)
    if (!Number.isInteger(days) || days < 0) {
      return {
        valid: false,
        error:
          'config.daysOverdue must be a non-negative integer for invoice_overdue trigger',
      }
    }
  }

  // Action-specific config validation
  switch (actionType) {
    case 'send_email': {
      const hasSubject =
        typeof cfg.subject === 'string' && cfg.subject.trim().length > 0
      const hasTemplate =
        typeof cfg.template === 'string' && cfg.template.trim().length > 0
      if (!hasSubject && !hasTemplate) {
        return {
          valid: false,
          error:
            'send_email action requires config.subject or config.template to be a non-empty string',
        }
      }
      if (
        cfg.recipientEmail !== undefined &&
        (typeof cfg.recipientEmail !== 'string' ||
          !cfg.recipientEmail.includes('@'))
      ) {
        return {
          valid: false,
          error: 'config.recipientEmail must be a valid email address',
        }
      }
      break
    }
    case 'send_notification': {
      const hasMessage =
        typeof cfg.message === 'string' && cfg.message.trim().length > 0
      const hasChannel =
        typeof cfg.channel === 'string' && cfg.channel.trim().length > 0
      if (!hasMessage && !hasChannel) {
        return {
          valid: false,
          error:
            'send_notification action requires config.message or config.channel to be a non-empty string',
        }
      }
      break
    }
    case 'tag_client':
    case 'tag_invoice': {
      const hasTagId =
        typeof cfg.tagId === 'string' && cfg.tagId.trim().length > 0
      const hasTagName =
        typeof cfg.tagName === 'string' && cfg.tagName.trim().length > 0
      if (!hasTagId && !hasTagName) {
        return {
          valid: false,
          error: `${actionType} action requires config.tagId or config.tagName to be a non-empty string`,
        }
      }
      break
    }
    case 'create_task': {
      const hasTitle =
        (typeof cfg.title === 'string' && cfg.title.trim().length > 0) ||
        (typeof cfg.taskTitle === 'string' && cfg.taskTitle.trim().length > 0)
      if (!hasTitle) {
        return {
          valid: false,
          error:
            'create_task action requires config.title or config.taskTitle to be a non-empty string',
        }
      }
      break
    }
    case 'send_webhook': {
      const url =
        typeof cfg.url === 'string'
          ? cfg.url.trim()
          : typeof cfg.webhookUrl === 'string'
            ? cfg.webhookUrl.trim()
            : ''
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return {
          valid: false,
          error:
            'send_webhook action requires config.url or config.webhookUrl starting with http:// or https://',
        }
      }
      break
    }
  }

  return { valid: true }
}

async function authenticate(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return {
      error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }),
    }
  }

  const user =
    (await prisma.user.findUnique({ where: { privyId: claims.userId } })) ??
    (await prisma.user.findUnique({ where: { id: claims.userId } }))
  if (!user) {
    return {
      error: NextResponse.json({ error: 'User not found' }, { status: 404 }),
    }
  }

  return { user }
}

function serializeAutomation(automation: Record<string, any>) {
  return {
    id: automation.id,
    userId: automation.userId,
    name: automation.name,
    triggerType: automation.triggerType,
    actionType: automation.actionType,
    config: automation.config ?? {},
    isActive: automation.isActive ?? true,
    lastRunAt: automation.lastRunAt
      ? new Date(automation.lastRunAt).toISOString()
      : null,
    createdAt: automation.createdAt
      ? new Date(automation.createdAt).toISOString()
      : null,
    updatedAt: automation.updatedAt
      ? new Date(automation.updatedAt).toISOString()
      : null,
  }
}

/**
 * GET /api/automations
 * Lists `Automation` rules belonging to the authenticated user.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    const automations = ((await prisma.automation.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    })) ?? []) as Array<Record<string, any>>

    return NextResponse.json({
      automations: automations.map(serializeAutomation),
      total: automations.length,
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'GET /api/automations error')
    return NextResponse.json(
      { error: 'Failed to list automations' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/automations
 * Creates an `Automation` rule (`name`, `triggerType`, `actionType`, `config`):
 * - Validates `triggerType` and `actionType` against defined allowed values, rejecting
 *   unknown values or unsupported combinations (`400`).
 * - Validates the `config` JSON payload shape matches what the chosen trigger and action require (`400`).
 * - Defaults `isActive` to `true`.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    let body: Record<string, unknown>
    try {
      body = ((await request.json()) ?? {}) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) {
      return NextResponse.json(
        { error: 'name is required and must be non-empty', code: 'NAME_REQUIRED' },
        { status: 400 },
      )
    }
    if (name.length > MAX_AUTOMATION_NAME_LENGTH) {
      return NextResponse.json(
        {
          error: `name must be at most ${MAX_AUTOMATION_NAME_LENGTH} characters`,
          code: 'NAME_TOO_LONG',
        },
        { status: 400 },
      )
    }

    const rawTrigger =
      typeof body.triggerType === 'string'
        ? body.triggerType.trim()
        : typeof body.trigger === 'string'
          ? body.trigger.trim()
          : ''
    if (!(ALLOWED_TRIGGER_TYPES as readonly string[]).includes(rawTrigger)) {
      return NextResponse.json(
        {
          error: `triggerType must be one of: ${ALLOWED_TRIGGER_TYPES.join(', ')}`,
          code: 'INVALID_TRIGGER_TYPE',
        },
        { status: 400 },
      )
    }
    const triggerType = rawTrigger as AutomationTriggerType

    const rawAction =
      typeof body.actionType === 'string'
        ? body.actionType.trim()
        : typeof body.action === 'string'
          ? body.action.trim()
          : ''
    if (!(ALLOWED_ACTION_TYPES as readonly string[]).includes(rawAction)) {
      return NextResponse.json(
        {
          error: `actionType must be one of: ${ALLOWED_ACTION_TYPES.join(', ')}`,
          code: 'INVALID_ACTION_TYPE',
        },
        { status: 400 },
      )
    }
    const actionType = rawAction as AutomationActionType

    const supportedActions = SUPPORTED_TRIGGER_ACTIONS[triggerType]
    if (!supportedActions.includes(actionType)) {
      return NextResponse.json(
        {
          error: `Unsupported combination: triggerType "${triggerType}" cannot be paired with actionType "${actionType}"`,
          code: 'UNSUPPORTED_TRIGGER_ACTION_COMBINATION',
        },
        { status: 400 },
      )
    }

    const configValidation = validateAutomationConfig(
      triggerType,
      actionType,
      body.config,
    )
    if (!configValidation.valid) {
      return NextResponse.json(
        {
          error: configValidation.error ?? 'Invalid automation config',
          code: 'INVALID_AUTOMATION_CONFIG',
        },
        { status: 400 },
      )
    }

    if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
      return NextResponse.json(
        { error: 'isActive must be a boolean', code: 'INVALID_IS_ACTIVE' },
        { status: 400 },
      )
    }
    const isActive = body.isActive !== undefined ? body.isActive : true

    const created = await prisma.automation.create({
      data: {
        userId: user.id,
        name,
        triggerType,
        actionType,
        config: body.config as Record<string, any>,
        isActive,
      },
    })

    return NextResponse.json(
      {
        automation: serializeAutomation(created),
      },
      { status: 201 },
    )
  } catch (error) {
    logger?.error?.({ err: error }, 'POST /api/automations error')
    return NextResponse.json(
      { error: 'Failed to create automation' },
      { status: 500 },
    )
  }
}
