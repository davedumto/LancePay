import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { z } from 'zod'

const hexColorSchema = z
  .string()
  .regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Invalid hex color')

const layoutSchema = z.enum(['modern', 'classic', 'minimal'])

const updateTemplateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  logoUrl: z.string().url().optional().nullable(),
  primaryColor: hexColorSchema.optional(),
  accentColor: hexColorSchema.optional(),
  showLogo: z.boolean().optional(),
  showFooter: z.boolean().optional(),
  footerText: z.string().max(500).optional().nullable(),
  layout: layoutSchema.optional(),
  isDefault: z.boolean().optional(),
})

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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await getAuthenticatedUser(request)
    if ('error' in auth) return auth.error

    const { user } = auth
    const { id } = await params

    const template = await prisma.invoiceTemplate.findFirst({
      where: { id, userId: user.id },
    })

    if (!template) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    }

    return NextResponse.json({ template })
  } catch (error) {
    console.error('Error fetching invoice template:', error)
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

    const { user } = auth
    const { id } = await params

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

    const data = parsed.data

    const existing = await prisma.invoiceTemplate.findFirst({
      where: { id, userId: user.id },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    }

    const shouldBeDefault = data.isDefault === true

    const template = await prisma.$transaction(async (tx) => {
      if (shouldBeDefault) {
        await tx.invoiceTemplate.updateMany({
          where: { userId: user.id, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        })
      }

      return tx.invoiceTemplate.update({
        where: { id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.logoUrl !== undefined ? { logoUrl: data.logoUrl } : {}),
          ...(data.primaryColor !== undefined ? { primaryColor: data.primaryColor } : {}),
          ...(data.accentColor !== undefined ? { accentColor: data.accentColor } : {}),
          ...(data.showLogo !== undefined ? { showLogo: data.showLogo } : {}),
          ...(data.showFooter !== undefined ? { showFooter: data.showFooter } : {}),
          ...(data.footerText !== undefined ? { footerText: data.footerText } : {}),
          ...(data.layout !== undefined ? { layout: data.layout } : {}),
          ...(data.isDefault !== undefined ? { isDefault: shouldBeDefault } : {}),
        },
      })
    })

    return NextResponse.json({ template })
  } catch (error) {
    console.error('Error updating invoice template:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await getAuthenticatedUser(request)
    if ('error' in auth) return auth.error

    const { user } = auth
    const { id } = await params

    const template = await prisma.invoiceTemplate.findFirst({
      where: { id, userId: user.id },
    })

    if (!template) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    }

    await prisma.invoiceTemplate.delete({ where: { id } })

    // Ensure user still has a default template if any remain
    if (template.isDefault) {
      const nextTemplate = await prisma.invoiceTemplate.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: 'asc' },
      })

      if (nextTemplate) {
        await prisma.invoiceTemplate.update({
          where: { id: nextTemplate.id },
          data: { isDefault: true },
        })
      }
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting invoice template:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    )
  }
}

