import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { z } from 'zod'
import { logger } from '@/lib/logger'

const hexColorSchema = z
  .string()
  .regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Invalid hex color')

const layoutSchema = z.enum(['modern', 'classic', 'minimal'])

const createTemplateSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name is too long'),
  logoUrl: z.string().url().optional().nullable(),
  primaryColor: hexColorSchema.optional(),
  accentColor: hexColorSchema.optional(),
  showLogo: z.boolean().optional(),
  showFooter: z.boolean().optional(),
  footerText: z.string().max(500).optional().nullable(),
  layout: layoutSchema.optional(),
  isDefault: z.boolean().optional(),
})

const updateTemplateSchema = createTemplateSchema.partial()

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
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

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser(request)
    if ('error' in auth) return auth.error

    const { user } = auth

    const templates = await prisma.invoiceTemplate.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
    })

    return NextResponse.json({ templates })
  } catch (error) {
    logger.error({ err: error }, 'Error fetching invoice templates:')
    return NextResponse.json(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser(request)
    if ('error' in auth) return auth.error

    const { user } = auth

    const existingCount = await prisma.invoiceTemplate.count({
      where: { userId: user.id },
    })

    if (existingCount >= 5) {
      return NextResponse.json(
        { error: 'You can only have up to 5 invoice templates' },
        { status: 400 },
      )
    }

    const body = await request.json()
    const parsed = createTemplateSchema.safeParse(body)

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

    const data = parsed.data

    const shouldBeDefault = data.isDefault === true || existingCount === 0

    const template = await prisma.$transaction(async (tx) => {
      if (shouldBeDefault) {
        await tx.invoiceTemplate.updateMany({
          where: { userId: user.id, isDefault: true },
          data: { isDefault: false },
        })
      }

      return tx.invoiceTemplate.create({
        data: {
          userId: user.id,
          name: data.name,
          logoUrl: data.logoUrl ?? null,
          primaryColor: data.primaryColor ?? '#000000',
          accentColor: data.accentColor ?? '#059669',
          showLogo: data.showLogo ?? true,
          showFooter: data.showFooter ?? true,
          footerText: data.footerText ?? null,
          layout: data.layout ?? 'modern',
          isDefault: shouldBeDefault,
        },
      })
    })

    return NextResponse.json({ template }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'Error creating invoice template:')
    return NextResponse.json(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    )
  }
}
