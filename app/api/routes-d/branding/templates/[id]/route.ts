import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { z } from 'zod'
import { logger } from '@/lib/logger'

const hexColorSchema = z
  .string()
  .regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Invalid hex color')

const logoUrlSchema = z.union([
  z.string().url(),
  z.string().startsWith('/branding-logos/'),
  z.string().startsWith('data:image/'),
])

const layoutSchema = z.enum(['modern', 'classic', 'minimal'])
const MAX_LOGO_SIZE_BYTES = 2 * 1024 * 1024

const updateTemplateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  logoUrl: logoUrlSchema.optional().nullable(),
  primaryColor: hexColorSchema.optional(),
  accentColor: hexColorSchema.optional(),
  showLogo: z.boolean().optional(),
  showFooter: z.boolean().optional(),
  footerText: z.string().max(500).optional().nullable(),
  layout: layoutSchema.optional(),
  isDefault: z.boolean().optional(),
})

function getDataUrlSizeBytes(value: string | null | undefined): number | null {
  if (!value?.startsWith('data:image/')) return null

  const separatorIndex = value.indexOf(',')
  if (separatorIndex === -1) return null

  const metadata = value.slice(0, separatorIndex)
  const payload = value.slice(separatorIndex + 1).replace(/\s/g, '')

  if (!payload) return 0

  if (metadata.includes(';base64')) {
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
    return Math.floor((payload.length * 3) / 4) - padding
  }

  try {
    return decodeURIComponent(payload).length
  } catch {
    return null
  }
}

async function getAuthenticatedUser(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) as const }
  }

  const authToken = authHeader.replace('Bearer ', '').trim()
  if (!authToken) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) as const }
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return { error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) as const }
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return { error: NextResponse.json({ error: 'User not found' }, { status: 404 }) as const }
  }

  return { user }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await getAuthenticatedUser(request)
    if ('error' in auth) return auth.error

    const { id } = await params
    const template = await prisma.invoiceTemplate.findFirst({
      where: { id, userId: auth.user.id },
    })

    if (!template) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    }

    return NextResponse.json({ template })
  } catch (error) {
    logger.error({ err: error }, 'Error fetching invoice template')
    return NextResponse.json(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    )
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await getAuthenticatedUser(request)
    if ('error' in auth) return auth.error

    const { id } = await params
    const existing = await prisma.invoiceTemplate.findFirst({
      where: { id, userId: auth.user.id },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    }

    const body = await request.json()
    const parsed = updateTemplateSchema.safeParse(body)

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]
      return NextResponse.json(
        {
          error: 'Validation failed',
          message: firstIssue?.message ?? 'Invalid payload',
          details: parsed.error.flatten().fieldErrors,
        },
        { status: 400 },
      )
    }

    if (parsed.data.logoUrl !== undefined) {
      const logoSize = getDataUrlSizeBytes(parsed.data.logoUrl)
      if (logoSize !== null && logoSize > MAX_LOGO_SIZE_BYTES) {
        return NextResponse.json(
          {
            error: 'Validation failed',
            message: 'Logo must be 2MB or less',
          },
          { status: 400 },
        )
      }
    }

    const templateData = parsed.data
    const shouldBeDefault = templateData.isDefault === true

    const template = await prisma.$transaction(async (tx) => {
      if (shouldBeDefault) {
        await tx.invoiceTemplate.updateMany({
          where: { userId: auth.user.id, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        })
      }

      return tx.invoiceTemplate.update({
        where: { id: existing.id },
        data: {
          ...(templateData.name !== undefined ? { name: templateData.name } : {}),
          ...(templateData.logoUrl !== undefined ? { logoUrl: templateData.logoUrl } : {}),
          ...(templateData.primaryColor !== undefined ? { primaryColor: templateData.primaryColor } : {}),
          ...(templateData.accentColor !== undefined ? { accentColor: templateData.accentColor } : {}),
          ...(templateData.showLogo !== undefined ? { showLogo: templateData.showLogo } : {}),
          ...(templateData.showFooter !== undefined ? { showFooter: templateData.showFooter } : {}),
          ...(templateData.footerText !== undefined ? { footerText: templateData.footerText } : {}),
          ...(templateData.layout !== undefined ? { layout: templateData.layout } : {}),
          ...(templateData.isDefault !== undefined ? { isDefault: templateData.isDefault } : {}),
        },
      })
    })

    return NextResponse.json({ template })
  } catch (error) {
    logger.error({ err: error }, 'Error updating invoice template')
    return NextResponse.json(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    )
  }
}
