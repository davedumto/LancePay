import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireScope, RoutesBForbiddenError } from '../../_lib/authz'
import { errorResponse } from '../../_lib/errors'

const TEMPLATE_IDS = [
  'invoice_sent',
  'invoice_reminder',
  'invoice_overdue',
  'payment_received',
  'dispute_opened',
  'dispute_resolved',
] as const

type TemplateId = typeof TEMPLATE_IDS[number]

const PREF_KEY = 'routesBEmailTemplates'
const MAX_SUBJECT_LENGTH = 200
const MAX_BODY_LENGTH = 10_000

interface EmailTemplate {
  subject: string
  body: string
  enabled: boolean
}

function getDefaultTemplate(id: TemplateId): EmailTemplate {
  return {
    subject: `{{default_subject_${id}}}`,
    body: `{{default_body_${id}}}`,
    enabled: true,
  }
}

function loadTemplates(raw?: string | null): Record<TemplateId, EmailTemplate> {
  const defaults = Object.fromEntries(
    TEMPLATE_IDS.map((id) => [id, getDefaultTemplate(id)]),
  ) as Record<TemplateId, EmailTemplate>

  if (!raw) return defaults

  try {
    const parsed = JSON.parse(raw)
    const stored = parsed?.[PREF_KEY]
    if (!stored || typeof stored !== 'object') return defaults
    return { ...defaults, ...(stored as Record<TemplateId, EmailTemplate>) }
  } catch {
    return defaults
  }
}

function mergeTemplates(
  raw: string | null | undefined,
  id: TemplateId,
  patch: Partial<EmailTemplate>,
): string {
  let parsed: Record<string, unknown> = {}
  try {
    if (raw) parsed = JSON.parse(raw)
  } catch {
    // ignore
  }

  const existing = parsed[PREF_KEY] as Record<TemplateId, EmailTemplate> | undefined
  const current = existing?.[id] ?? getDefaultTemplate(id)
  const updated = { ...current, ...patch }

  return JSON.stringify({
    ...parsed,
    [PREF_KEY]: { ...(existing ?? {}), [id]: updated },
  })
}

async function PATCHHandler(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const auth = await requireScope(request, 'routes-b:read')

    const templateId = params.id
    if (!TEMPLATE_IDS.includes(templateId as TemplateId)) {
      return errorResponse(
        'NOT_FOUND',
        `Unknown template id. Valid ids: ${TEMPLATE_IDS.join(', ')}`,
        {},
        404,
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('BAD_REQUEST', 'Invalid JSON body', {}, 400)
    }

    const b = body as Record<string, unknown>
    const patch: Partial<EmailTemplate> = {}

    if (b.subject !== undefined) {
      if (typeof b.subject !== 'string' || b.subject.length > MAX_SUBJECT_LENGTH) {
        return errorResponse(
          'BAD_REQUEST',
          `subject must be a string of at most ${MAX_SUBJECT_LENGTH} characters`,
          {},
          400,
        )
      }
      patch.subject = b.subject
    }

    if (b.body !== undefined) {
      if (typeof b.body !== 'string' || b.body.length > MAX_BODY_LENGTH) {
        return errorResponse(
          'BAD_REQUEST',
          `body must be a string of at most ${MAX_BODY_LENGTH} characters`,
          {},
          400,
        )
      }
      patch.body = b.body
    }

    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean') {
        return errorResponse('BAD_REQUEST', 'enabled must be a boolean', {}, 400)
      }
      patch.enabled = b.enabled
    }

    if (Object.keys(patch).length === 0) {
      return errorResponse('BAD_REQUEST', 'Provide at least one field to update: subject, body, enabled', {}, 400)
    }

    const existing = await prisma.reminderSettings.findUnique({
      where: { userId: auth.userId },
      select: { id: true, customMessage: true },
    })

    const newCustomMessage = mergeTemplates(existing?.customMessage, templateId as TemplateId, patch)

    if (existing) {
      await prisma.reminderSettings.update({
        where: { id: existing.id },
        data: { customMessage: newCustomMessage },
      })
    } else {
      await prisma.reminderSettings.create({
        data: { userId: auth.userId, customMessage: newCustomMessage },
      })
    }

    const templates = loadTemplates(newCustomMessage)
    return NextResponse.json({ template: { id: templateId, ...templates[templateId as TemplateId] } })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', {}, 401)
    }
    return errorResponse('INTERNAL', 'Failed to update email template', {}, 500)
  }
}

export const PATCH = withRequestId(PATCHHandler)
