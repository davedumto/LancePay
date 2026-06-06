import { withRequestId } from '../../../_lib/with-request-id'
import { withMethods } from '../../../_lib/with-methods'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { checkResourceOwnership } from '../../../_lib/access-control'
import { errorResponse } from '../../../_lib/errors'
import { registerRoute } from '../../../_lib/openapi'
import { renderToStream } from '@react-pdf/renderer'
import type { DocumentProps } from '@react-pdf/renderer'
import { InvoicePDF } from '@/lib/pdf'
import { logger } from '@/lib/logger'
import React from 'react'
import { z } from 'zod'

export const runtime = 'nodejs'

const invoiceIdParamsSchema = z.object({
  id: z.string().uuid('Invoice id must be a valid UUID'),
})

registerRoute({
  method: 'GET',
  path: '/invoices/{id}/pdf',
  summary: 'Download invoice PDF',
  description: 'Generate and download a PDF for an invoice owned by the authenticated user.',
  requestSchema: invoiceIdParamsSchema,
  responseSchema: z.any(),
  tags: ['invoices'],
})

async function GETHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const parsedParams = invoiceIdParamsSchema.safeParse({ id })
    if (!parsedParams.success) {
      return errorResponse(
        'BAD_REQUEST',
        'Invalid invoice id',
        { fields: { id: 'Must be a valid UUID' } },
        400,
      )
    }

    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return errorResponse('UNAUTHORIZED', 'Unauthorized', undefined, 401)
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return errorResponse('UNAUTHORIZED', 'Unauthorized', undefined, 401)
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return errorResponse('NOT_FOUND', 'User not found', undefined, 404)
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: parsedParams.data.id },
      select: {
        id: true,
        userId: true,
        invoiceNumber: true,
        clientEmail: true,
        clientName: true,
        description: true,
        amount: true,
        currency: true,
        status: true,
        paymentLink: true,
        dueDate: true,
        paidAt: true,
        createdAt: true,
      },
    })

    if (!invoice) {
      return errorResponse('NOT_FOUND', 'Invoice not found', undefined, 404)
    }

    const accessCheck = checkResourceOwnership(invoice.userId, user.id)
    if (accessCheck) {
      return errorResponse('NOT_FOUND', 'Invoice not found', undefined, 404)
    }

    const branding = await prisma.brandingSettings.findUnique({ where: { userId: user.id } })

    const stream = await renderToStream(
      React.createElement(InvoicePDF, {
        invoice: {
          invoiceNumber: invoice.invoiceNumber,
          freelancerName: user.name || user.email,
          freelancerEmail: user.email,
          clientName: invoice.clientName || 'Client',
          clientEmail: invoice.clientEmail,
          description: invoice.description,
          amount: Number(invoice.amount),
          currency: invoice.currency,
          status: invoice.status,
          dueDate: invoice.dueDate ? invoice.dueDate.toISOString() : null,
          createdAt: invoice.createdAt.toISOString(),
          paidAt: invoice.paidAt ? invoice.paidAt.toISOString() : null,
          paymentLink: invoice.paymentLink,
        },
        branding: branding ?? undefined,
      }) as unknown as React.ReactElement<DocumentProps>,
    )

    return new NextResponse(stream as unknown as ReadableStream, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="invoice-${invoice.invoiceNumber}.pdf"`,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Failed to generate invoice PDF')
    return errorResponse('INTERNAL', 'Failed to generate PDF', undefined, 500)
  }
}

export const { GET } = withMethods({
  GET: withRequestId(GETHandler),
})
