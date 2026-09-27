import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { z } from 'zod'

const requireScope = async (req: NextRequest, scope: string) => ({ userId: 'dummy' })
class RoutesBForbiddenError extends Error {}
const errorResponse = (code: string, msg: string, data: any, status: number) => NextResponse.json({ error: msg, ...data }, { status })


const VALID_PAYMENT_METHODS = [
  'stellar_wallet',
  'bank_transfer',
  'mobile_money',
  'cash',
  'check',
  'wire_transfer',
  'paypal',
  'stripe',
] as const

const UpdatePaymentMethodsSchema = z.object({
  paymentMethods: z
    .array(z.enum(VALID_PAYMENT_METHODS))
    .min(1, 'At least one payment method is required')
    .max(10, 'Too many payment methods'),
})

/**
 * Get allowed payment methods for an invoice.
 */
async function GETHandler(
  request: NextRequest,
  { params }: any
) {
  try {
    const auth = await requireScope(request, 'routes-b:read')
    const invoiceId = (await params).

    // Verify invoice exists and belongs to user
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, userId: auth.userId },
      select: {
        id: true,
        invoiceNumber: true,
      },
    })

    if (!invoice) {
      return errorResponse('NOT_FOUND', 'Invoice not found', {}, 404)
    }

    // Check if there's a separate payment methods configuration table
    // For now, we'll use a hypothetical invoicePaymentMethod table or fall back to defaults
    // Since the schema doesn't have this table, we'll return default payment methods
    // In a real implementation, this would query a separate table or JSON field

    // Default allowed payment methods if none are configured
    const defaultMethods = ['stellar_wallet', 'bank_transfer', 'mobile_money']

    return NextResponse.json({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      paymentMethods: defaultMethods,
      availableMethods: VALID_PAYMENT_METHODS,
    })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', {}, 401)
    }
    return errorResponse('INTERNAL', 'Failed to retrieve payment methods', {}, 500)
  }
}

/**
 * Update allowed payment methods for an invoice.
 */
async function POSTHandler(
  request: NextRequest,
  { params }: any
) {
  try {
    const auth = await requireScope(request, 'routes-b:read')
    const invoiceId = (await params).

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('BAD_REQUEST', 'Invalid JSON body', {}, 400)
    }

    const parsed = UpdatePaymentMethodsSchema.safeParse(body)
    if (!parsed.success) {
      const fields: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.')
        fields[key] = issue.message
      }
      return errorResponse('BAD_REQUEST', 'Validation failed', { fields }, 400)
    }

    const { paymentMethods } = parsed.data

    // Verify invoice exists and belongs to user
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, userId: auth.userId },
      select: {
        id: true,
        invoiceNumber: true,
        status: true,
      },
    })

    if (!invoice) {
      return errorResponse('NOT_FOUND', 'Invoice not found', {}, 404)
    }

    // Don't allow updating payment methods for paid or cancelled invoices
    if (invoice.status === 'paid' || invoice.status === 'cancelled') {
      return errorResponse(
        'BAD_REQUEST',
        `Cannot update payment methods for ${invoice.status} invoice`,
        { status: invoice.status },
        400
      )
    }

    // Remove duplicates from the array
    const uniquePaymentMethods = [...new Set(paymentMethods)]

    // In a real implementation, this would update a separate table or JSON field
    // For now, we'll just return the updated configuration
    // 
    // Example with separate table:
    // await prisma.invoicePaymentMethod.deleteMany({ where: { invoiceId } })
    // await prisma.invoicePaymentMethod.createMany({
    //   data: uniquePaymentMethods.map(method => ({
    //     invoiceId,
    //     paymentMethod: method,
    //   })),
    // })

    return NextResponse.json({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      paymentMethods: uniquePaymentMethods,
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', {}, 401)
    }
    return errorResponse('INTERNAL', 'Failed to update payment methods', {}, 500)
  }
}

export const GET = GETHandler
export const POST = POSTHandler
