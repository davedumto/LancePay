import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// GET, PATCH /api/routes-b/invoices/[id]/locale — per-invoice locale override

const SUPPORTED_LOCALES = ['en', 'fr', 'es', 'de', 'pt', 'zh', 'ar', 'ja', 'ko']

const db = prisma as unknown as {
  invoiceLocalePreference: {
    findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
    upsert: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  }
  languagePreference: {
    findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  }
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

function defaultLocale() {
  return { locale: 'en', dateFormat: null, numberFormat: null }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const invoice = await prisma.invoice.findFirst({
      where: { id, userId: user.id },
      select: { id: true },
    })
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

    const override = await db.invoiceLocalePreference.findUnique({
      where: { invoiceId: id },
    })

    if (override) {
      return NextResponse.json({
        invoiceId: id,
        locale: override.locale ?? 'en',
        dateFormat: override.dateFormat ?? null,
        numberFormat: override.numberFormat ?? null,
        isOverride: true,
      })
    }

    const userPrefs = await db.languagePreference.findUnique({
      where: { userId: user.id },
    })

    const fallback = userPrefs
      ? {
          locale: userPrefs.locale ?? 'en',
          dateFormat: userPrefs.dateFormat ?? null,
          numberFormat: userPrefs.numberFormat ?? null,
        }
      : defaultLocale()

    return NextResponse.json({
      invoiceId: id,
      ...fallback,
      isOverride: false,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/invoices/[id]/locale error')
    return NextResponse.json({ error: 'Failed to fetch invoice locale' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const invoice = await prisma.invoice.findFirst({
      where: { id, userId: user.id },
      select: { id: true },
    })
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as Record<string, unknown>
    const { locale, dateFormat, numberFormat } = payload

    if (locale !== undefined) {
      if (typeof locale !== 'string' || !SUPPORTED_LOCALES.includes(locale)) {
        return NextResponse.json(
          { error: `locale must be one of: ${SUPPORTED_LOCALES.join(', ')}` },
          { status: 400 },
        )
      }
    }

    const updateData: Record<string, unknown> = {}
    if (locale !== undefined) updateData.locale = locale
    if (dateFormat !== undefined) {
      updateData.dateFormat =
        typeof dateFormat === 'string' ? dateFormat.trim() || null : null
    }
    if (numberFormat !== undefined) {
      updateData.numberFormat =
        typeof numberFormat === 'string' ? numberFormat.trim() || null : null
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'At least one field must be provided' }, { status: 400 })
    }

    const preferences = await db.invoiceLocalePreference.upsert({
      where: { invoiceId: id },
      update: { ...updateData, updatedAt: new Date() },
      create: { invoiceId: id, locale: 'en', ...updateData },
    })

    return NextResponse.json({
      invoiceId: id,
      locale: preferences.locale ?? 'en',
      dateFormat: preferences.dateFormat ?? null,
      numberFormat: preferences.numberFormat ?? null,
      isOverride: true,
    })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/routes-b/invoices/[id]/locale error')
    return NextResponse.json({ error: 'Failed to update invoice locale' }, { status: 500 })
  }
}
