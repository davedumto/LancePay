import { withRequestId } from '../_lib/with-request-id'
import { withBodyLimit } from '../_lib/with-body-limit'
import { withMethods } from '../_lib/with-methods'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { createRouteLogger } from '../_shared/logger'
import { registerRoute } from '../_lib/openapi'

const log = createRouteLogger({ route: '/api/routes-b/branding' })
import { hasTableColumn } from '../_lib/table-columns'
import { brandingSchema, type BrandingPayload } from './schema'
import { errorResponse } from '../_lib/errors'
import { validateLogoUrl } from '../_lib/logo-validation'
import { z } from 'zod'

// Register OpenAPI documentation
registerRoute({
  method: 'GET',
  path: '/branding',
  summary: 'Get branding settings',
  description: 'Get the authenticated user\'s branding settings.',
  responseSchema: z.object({
    branding: z.object({
      id: z.string(),
      userId: z.string(),
      logoUrl: z.string().nullable(),
      primaryColor: z.string().nullable(),
      footerText: z.string().nullable(),
      signatureUrl: z.string().nullable(),
      createdAt: z.string(),
      secondaryColor: z.string().nullable().optional(),
      customDomain: z.string().nullable().optional(),
      accentColor: z.string().nullable().optional(),
    }).nullable(),
  }),
  tags: ['branding'],
})

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
    }),
  }),
  tags: ['branding'],
})

function formatFieldErrors(error: {
  issues: Array<{ path: Array<string | number>; message: string }>
}) {
  return error.issues.reduce<Record<string, string>>((fields, issue) => {
    const key = typeof issue.path[0] === 'string' ? issue.path[0] : 'body'
    if (!fields[key]) fields[key] = issue.message
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

  if (supportedColumns[0] && 'secondaryColor' in payload) {
    await prisma.$executeRaw`
      UPDATE "BrandingSettings"
      SET "secondaryColor" = ${payload.secondaryColor ?? null},
          "updatedAt" = NOW()
      WHERE "userId" = ${userId}
    `
  }

  if (supportedColumns[1] && 'customDomain' in payload) {
    await prisma.$executeRaw`
      UPDATE "BrandingSettings"
      SET "customDomain" = ${payload.customDomain ?? null},
          "updatedAt" = NOW()
      WHERE "userId" = ${userId}
    `
  }

  if (supportedColumns[2] && 'accentColor' in payload) {
    await prisma.$executeRaw`
      UPDATE "BrandingSettings"
      SET "accentColor" = ${payload.accentColor ?? null},
          "updatedAt" = NOW()
      WHERE "userId" = ${userId}
    `
  }

  return {
    secondaryColor: supportedColumns[0] ? payload.secondaryColor : undefined,
    customDomain: supportedColumns[1] ? payload.customDomain : undefined,
    accentColor: supportedColumns[2] ? payload.accentColor : undefined,
  }
}

async function writeBranding(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return errorResponse('UNAUTHORIZED', 'Unauthorized', {}, 401)
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse(
        'BAD_REQUEST',
        'Invalid request body',
        { fields: { body: 'Invalid JSON' } },
        422
      )
    }

    const parsed = brandingSchema.safeParse(body)
    if (!parsed.success) {
      return errorResponse(
        'BAD_REQUEST',
        'Invalid branding payload',
        { fields: formatFieldErrors(parsed.error) },
        422
      )
    }

    const payload = parsed.data

    if (payload.logoUrl) {
      const logoCheck = await validateLogoUrl(payload.logoUrl)
      if (!logoCheck.ok) {
        return errorResponse(
          'BAD_REQUEST',
          'Invalid logo URL',
          { fields: { logoUrl: logoCheck.error } },
          422
        )
      }
    }

    const baseFields: Record<string, unknown> = {}

    if ('logoUrl' in payload) baseFields.logoUrl = payload.logoUrl ?? null
    if ('primaryColor' in payload) baseFields.primaryColor = payload.primaryColor
    if ('footerText' in payload) baseFields.footerText = payload.footerText ?? null
    if ('signatureUrl' in payload) baseFields.signatureUrl = payload.signatureUrl ?? null

    const branding = await prisma.brandingSettings.upsert({
      where: { userId: user.id },
      update: baseFields,
      create: { userId: user.id, ...baseFields },
    })

    const optional = await updateOptionalColumns(user.id, payload)

    return NextResponse.json({
      branding: {
        ...branding,
        ...(optional.secondaryColor !== undefined
          ? { secondaryColor: optional.secondaryColor ?? null }
          : {}),
        ...(optional.customDomain !== undefined
          ? { customDomain: optional.customDomain ?? null }
          : {}),
        ...(optional.accentColor !== undefined
          ? { accentColor: optional.accentColor ?? null }
          : {}),
      },
    })
  } catch (error) {
    log.error({ err: error }, 'branding update error')
    return errorResponse('INTERNAL', 'Failed to update branding settings', {}, 500)
  }
}

// GET /api/routes-b/branding — return the authenticated user's branding
// settings, or { branding: null } (200, not 404) when none has been set up.
async function GETHandler(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const branding = await prisma.brandingSettings.findUnique({
      where: { userId: user.id },
      select: {
        id: true,
        logoUrl: true,
        primaryColor: true,
        footerText: true,
        signatureUrl: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ branding: branding ?? null })
  } catch (error) {
    log.error({ err: error }, 'branding GET error')
    return NextResponse.json({ error: 'Failed to get branding' }, { status: 500 })
  }
}

async function PATCHHandler(request: NextRequest) {
  return writeBranding(request)
}

export const { GET, POST, PUT, DELETE, PATCH } = withMethods({
  GET: withRequestId(GETHandler),
  PATCH: withRequestId(withBodyLimit(PATCHHandler, { limitBytes: 1024 * 1024 })),
})