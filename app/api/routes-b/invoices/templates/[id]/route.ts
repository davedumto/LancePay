import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// GET /api/routes-b/invoices/templates/[id] — fetch a single invoice
// template owned by the authenticated user.

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const template = await prisma.invoiceTemplate.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        name: true,
        clientEmail: true,
        clientName: true,
        description: true,
        amount: true,
        currency: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    if (!template) {
      return NextResponse.json({ error: 'Invoice template not found' }, { status: 404 })
    }
    if (template.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    return NextResponse.json({
      template: {
        id: template.id,
        name: template.name,
        clientEmail: template.clientEmail,
        clientName: template.clientName,
        description: template.description,
        amount: Number(template.amount),
        currency: template.currency,
        createdAt: template.createdAt.toISOString(),
        updatedAt: template.updatedAt.toISOString(),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/invoices/templates/[id] error')
    return NextResponse.json({ error: 'Failed to fetch invoice template' }, { status: 500 })
  }
}
