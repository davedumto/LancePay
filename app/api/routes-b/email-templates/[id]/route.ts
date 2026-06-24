import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── PATCH /api/routes-b/email-templates/[id] — update an email template ──

const MAX_NAME_LENGTH = 100
const MAX_SUBJECT_LENGTH = 255
const MAX_BODY_LENGTH = 50_000
const VALID_TYPES = ['invoice', 'reminder', 'receipt', 'custom'] as const
type TemplateType = typeof VALID_TYPES[number]

type EmailTemplate = {
  id: string
  userId: string
  name: string
  subject: string
  body: string
  type: TemplateType
  isDefault: boolean
  createdAt: Date
  updatedAt: Date
}

type EmailTemplateDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<EmailTemplate | null>
  update: (args: Record<string, unknown>) => Promise<EmailTemplate>
}

function getTemplateDelegate(): EmailTemplateDelegate {
  return (prisma as unknown as { emailTemplate: EmailTemplateDelegate }).emailTemplate
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    const delegate = getTemplateDelegate()

    const template = await delegate.findUnique({
      where: { id },
      select: { id: true, userId: true },
    })
    if (!template) {
      return NextResponse.json({ error: 'Email template not found' }, { status: 404 })
    }
    if ((template as unknown as { userId: string }).userId !== user.id) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    }

    const body = (await request.json().catch(() => null)) as {
      name?: string
      subject?: string
      body?: string
      type?: string
      isDefault?: boolean
    } | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const update: Partial<EmailTemplate> = {}

    if ('name' in body) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 })
      }
      const trimmed = body.name.trim()
      if (trimmed.length > MAX_NAME_LENGTH) {
        return NextResponse.json(
          { error: `name must be at most ${MAX_NAME_LENGTH} characters` },
          { status: 400 },
        )
      }
      update.name = trimmed
    }

    if ('subject' in body) {
      if (typeof body.subject !== 'string' || !body.subject.trim()) {
        return NextResponse.json({ error: 'subject must be a non-empty string' }, { status: 400 })
      }
      const trimmed = body.subject.trim()
      if (trimmed.length > MAX_SUBJECT_LENGTH) {
        return NextResponse.json(
          { error: `subject must be at most ${MAX_SUBJECT_LENGTH} characters` },
          { status: 400 },
        )
      }
      update.subject = trimmed
    }

    if ('body' in body) {
      if (typeof body.body !== 'string') {
        return NextResponse.json({ error: 'body must be a string' }, { status: 400 })
      }
      if (body.body.length > MAX_BODY_LENGTH) {
        return NextResponse.json(
          { error: `body must be at most ${MAX_BODY_LENGTH} characters` },
          { status: 400 },
        )
      }
      update.body = body.body
    }

    if ('type' in body) {
      if (!VALID_TYPES.includes(body.type as TemplateType)) {
        return NextResponse.json(
          { error: `type must be one of: ${VALID_TYPES.join(', ')}` },
          { status: 400 },
        )
      }
      update.type = body.type as TemplateType
    }

    if ('isDefault' in body) {
      if (typeof body.isDefault !== 'boolean') {
        return NextResponse.json({ error: 'isDefault must be a boolean' }, { status: 400 })
      }
      update.isDefault = body.isDefault
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'No valid fields provided for update' }, { status: 400 })
    }

    const updated = await delegate.update({
      where: { id },
      data: update,
      select: {
        id: true,
        name: true,
        subject: true,
        body: true,
        type: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ template: updated })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/routes-b/email-templates/[id] error')
    return NextResponse.json({ error: 'Failed to update email template' }, { status: 500 })
  }
}
