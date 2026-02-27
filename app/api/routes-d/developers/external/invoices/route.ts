import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { authenticateApiKey } from '@/app/api/routes-d/developers/_shared'
import { externalInvoiceSchema } from '@/lib/validations'
import { generateInvoiceNumber } from '@/lib/utils'
import { logger } from '@/lib/logger'

// Rate limiting map (in production, use Redis or similar)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(userId: string): { allowed: boolean; error?: string } {
  const now = Date.now()
  const windowMs = 60 * 1000 // 1 minute
  const maxRequests = 30 // 30 requests per minute

  const userLimit = rateLimitMap.get(userId)

  if (!userLimit || now > userLimit.resetAt) {
    // Reset window
    rateLimitMap.set(userId, { count: 1, resetAt: now + windowMs })
    return { allowed: true }
  }

  if (userLimit.count >= maxRequests) {
    return {
      allowed: false,
      error: 'Rate limit exceeded. Maximum 30 requests per minute.'
    }
  }

  userLimit.count++
  return { allowed: true }
}

// POST /api/routes-d/developers/external/invoices - Create invoice via API key
export async function POST(request: NextRequest) {
  try {
    // Authenticate using API key
    const authResult = await authenticateApiKey(request)

    if (!authResult.success) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.statusCode }
      )
    }

    const { user } = authResult

    // Apply rate limiting
    const rateLimitCheck = checkRateLimit(user.id)
    if (!rateLimitCheck.allowed) {
      return NextResponse.json(
        { error: rateLimitCheck.error },
        { status: 429 }
      )
    }

    // Validate request body
    const body = await request.json()
    const parsed = externalInvoiceSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid request',
          details: parsed.error.issues.map(issue => ({
            field: issue.path.join('.'),
            message: issue.message
          }))
        },
        { status: 400 }
      )
    }

    const { clientEmail, clientName, description, amount, currency, dueDate } = parsed.data

    // Generate invoice number and payment link
    const invoiceNumber = generateInvoiceNumber()
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin
    const paymentLink = `${baseUrl}/pay/${invoiceNumber}`

    // Create invoice
    const invoice = await prisma.invoice.create({
      data: {
        userId: user.id,
        invoiceNumber,
        clientEmail,
        clientName,
        description,
        amount,
        currency: currency || 'USD',
        dueDate: dueDate ? new Date(dueDate) : null,
        paymentLink,
      },
      select: {
        id: true,
        invoiceNumber: true,
        clientEmail: true,
        clientName: true,
        description: true,
        amount: true,
        currency: true,
        status: true,
        paymentLink: true,
        dueDate: true,
        createdAt: true,
      }
    })

    return NextResponse.json(
      {
        success: true,
        invoice: {
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
          amount: Number(invoice.amount),
          currency: invoice.currency,
          paymentLink: invoice.paymentLink,
          createdAt: invoice.createdAt,
        }
      },
      { status: 201 }
    )
  } catch (error) {
    logger.error({ err: error }, 'External invoice creation error:')

    // Handle specific errors
    if (error instanceof Error) {
      if (error.message.includes('Unique constraint')) {
        return NextResponse.json(
          { error: 'Invoice number collision. Please retry.' },
          { status: 409 }
        )
      }
    }

    return NextResponse.json(
      { error: 'Failed to create invoice' },
      { status: 500 }
    )
  }
}
