import { withRequestId } from '../_lib/with-request-id'
import { withBodyLimit } from '../_lib/with-body-limit'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { registerRoute } from '../_lib/openapi'
import { hasTableColumn } from '../_lib/table-columns'
import { brandingSchema, type BrandingPayload } from './schema'
import { z } from 'zod'

// Register OpenAPI documentation
registerRoute({
  method: 'PATCH',
  path: '/branding',
  summary: 'Update branding settings',
  description:
    'Update logo, colors, footer text, or signature for invoice branding.',
  requestSchema: z.object({
    logoUrl: z.string().url().optional(),
    primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    footerText: z.string().max(200).optional(),
    signatureUrl: z.string().url().optional(),
  }),
  responseSchema: z.object({
    branding: z.object({
      id: z.string(),
      userId: z.string(),
      logoUrl: z.string().nullable(),
      primaryColor: z.string().nullable(),
      footerText: z.string().nullable(),
      signatureUrl: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  }),
  tags: ['branding'],
})

function formatFieldErrors(error: {
  issues: Array<{ path: Array<string | number>; message: string }>
}) {
  return error.issues.reduce<Record<string, string>>((fields, issue) => {
    const key = typeof issue.path[0] === 'string' ? issue.path[0] : 'body'
    if (!fields[key]) {
      fields[key] = issue.message
    }
    return fields
  }, {})
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers
    .get('authorization')
    ?.replace('Bearer ', '')

  if (!authToken) return null

  const claims = await verifyAuthToken(authToken)
  if (!claims) return null

  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

async function updateOptionalColumns(
  userId: string,
  payload: BrandingPayload
) {
  const supportedColumns = await Promise.all([
    hasTableColumn('BrandingSettings', 'secondaryColor'),
    hasTableColumn('BrandingSettings', 'customDomain'),
    hasTableColumn('BrandingSettings', 'accentColor'),
  ])

  if (
    supportedColumns[0] &&
    Object.prototype.hasOwnProperty.call(payload, 'secondaryColor')
  ) {
    await prisma.$executeRaw`
      UPDATE "BrandingSettings"
      SET "secondaryColor" = ${payload.secondaryColor ?? null},
          "updatedAt" = NOW()
      WHERE "userId" = ${userId}
    `
  }

  if (
    supportedColumns[1] &&
    Object.prototype.hasOwnProperty.call(payload, 'customDomain')
  ) {
    await prisma.$executeRaw`
      UPDATE "BrandingSettings"
      SET "customDomain" = ${payload.customDomain ?? null},
          "updatedAt" = NOW()
      WHERE "userId" = ${userId}
    `
  }

  if (
    supportedColumns[2] &&
    Object.prototype.hasOwnProperty.call(payload, 'accentColor')
  ) {
    await prisma.$executeRaw`
      UPDATE "BrandingSettings"
      SET "accentColor" = ${payload.accentColor ?? null},
          "updatedAt" = NOW()
      WHERE "userId" = ${userId}
    `
  }

  return {
    secondaryColor: supportedColumns[0]
      ? payload.secondaryColor
      : undefined,
    customDomain: supportedColumns[1]
      ? payload.customDomain
      : undefined,
    accentColor: supportedColumns[2] ? payload.accentColor : undefined,
  }
}

async function writeBranding(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        {
          error: 'Invalid request body',
          fields: { body: 'Body must be valid JSON' },
        },
        { status: 422 }
      )
    }

    const parsed = brandingSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid branding payload',
          fields: formatFieldErrors(parsed.error),
        },
        { status: 422 }
      )
    }

    const payload = parsed.data
    const baseFields: Record<string, unknown> = {}

    if (Object.prototype.hasOwnProperty.call(payload, 'logoUrl')) {
      baseFields.logoUrl = payload.logoUrl ?? null
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'primaryColor')) {
      baseFields.primaryColor = payload.primaryColor
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'footerText')) {
      baseFields.footerText = payload.footerText ?? null
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'signatureUrl')) {
      baseFields.signatureUrl = payload.signatureUrl ?? null
    }

    const branding = await prisma.brandingSettings.upsert({
      where: { userId: user.id },
      update: baseFields,
      create: {
        userId: user.id,
        ...baseFields,
      },
    })

    const optionalColumns = await updateOptionalColumns(
      user.id,
      payload
    )

    return NextResponse.json({
      branding: {
        ...branding,
        ...(optionalColumns.secondaryColor !== undefined
          ? { secondaryColor: optionalColumns.secondaryColor ?? null }
          : {}),
        ...(optionalColumns.customDomain !== undefined
          ? { customDomain: optionalColumns.customDomain ?? null }
          : {}),
        ...(optionalColumns.accentColor !== undefined
          ? { accentColor: optionalColumns.accentColor ?? null }
          : {}),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Routes B branding write error')
    return NextResponse.json(
      { error: 'Failed to update branding settings' },
      { status: 500 }
    )
  }
}

async function PATCHHandler(request: NextRequest) {
  return writeBranding(request)
}

export const PATCH = withRequestId(
  withBodyLimit(PATCHHandler, { limitBytes: 1024 * 1024 })
)