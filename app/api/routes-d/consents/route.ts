import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const CONSENT_KEYS = [
  'marketing_emails',
  'data_analytics',
  'third_party_sharing',
  'push_notifications',
] as const

type ConsentKey = typeof CONSENT_KEYS[number]

type ConsentRecord = Record<ConsentKey, boolean>

function defaultConsents(): ConsentRecord {
  return {
    marketing_emails: false,
    data_analytics: false,
    third_party_sharing: false,
    push_notifications: false,
  }
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

function parseConsentsFromJson(raw: unknown): ConsentRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const result = defaultConsents()
  for (const key of CONSENT_KEYS) {
    const val = (raw as Record<string, unknown>)[key]
    if (val !== undefined && typeof val !== 'boolean') return null
    if (typeof val === 'boolean') result[key] = val
  }
  return result
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const settings = await prisma.reminderSettings.findUnique({
      where: { userId: user.id },
      select: { id: true },
    })

    const consentsRaw = (settings as Record<string, unknown> | null)?.consents
    const consents: ConsentRecord =
      consentsRaw && typeof consentsRaw === 'object' && !Array.isArray(consentsRaw)
        ? (consentsRaw as ConsentRecord)
        : defaultConsents()

    return NextResponse.json({ consents })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/consents error')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
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

    const updates = parseConsentsFromJson(body)
    if (!updates) {
      return NextResponse.json(
        { error: `Each consent field must be a boolean. Allowed keys: ${CONSENT_KEYS.join(', ')}` },
        { status: 400 },
      )
    }

    const hasAtLeastOneKey = CONSENT_KEYS.some(
      (k) => (body as Record<string, unknown>)[k] !== undefined,
    )
    if (!hasAtLeastOneKey) {
      return NextResponse.json(
        { error: `Provide at least one consent key to update. Allowed keys: ${CONSENT_KEYS.join(', ')}` },
        { status: 400 },
      )
    }

    await prisma.reminderSettings.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        consents: updates as object,
        reminderDays: 3,
      },
      update: { consents: updates as object },
    })

    return NextResponse.json({ consents: updates })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/routes-d/consents error')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
