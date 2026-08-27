import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// GET /api/routes-b/email-templates/variables — list available email template variables

export interface EmailTemplateVariable {
  key: string
  name: string
  description: string
  category: 'invoice' | 'client' | 'freelancer' | 'general'
  example: string
}

export const EMAIL_TEMPLATE_CATEGORIES = ['invoice', 'client', 'freelancer', 'general'] as const

export const EMAIL_TEMPLATE_VARIABLES: EmailTemplateVariable[] = [
  {
    key: 'invoice_number',
    name: 'Invoice Number',
    description: 'The unique reference number of the invoice',
    category: 'invoice',
    example: 'INV-2026-001',
  },
  {
    key: 'invoice_amount',
    name: 'Invoice Amount',
    description: 'The total billed amount of the invoice',
    category: 'invoice',
    example: '1500.00',
  },
  {
    key: 'invoice_currency',
    name: 'Currency',
    description: 'The currency code of the invoice (e.g. USD, EUR, USDC)',
    category: 'invoice',
    example: 'USD',
  },
  {
    key: 'due_date',
    name: 'Due Date',
    description: 'The date by which payment is due',
    category: 'invoice',
    example: '2026-09-01',
  },
  {
    key: 'issue_date',
    name: 'Issue Date',
    description: 'The date the invoice was generated/issued',
    category: 'invoice',
    example: '2026-08-01',
  },
  {
    key: 'payment_link',
    name: 'Payment Link',
    description: 'The direct link for the client to pay the invoice',
    category: 'invoice',
    example: 'https://lancepay.app/pay/inv_123',
  },
  {
    key: 'invoice_description',
    name: 'Invoice Description',
    description: 'A brief description of services or line items billed',
    category: 'invoice',
    example: 'Web development services for August',
  },
  {
    key: 'client_name',
    name: 'Client Name',
    description: 'The name or organization name of the client',
    category: 'client',
    example: 'Acme Corp',
  },
  {
    key: 'client_email',
    name: 'Client Email',
    description: 'The email address of the client',
    category: 'client',
    example: 'billing@acme.com',
  },
  {
    key: 'freelancer_name',
    name: 'Freelancer Name',
    description: 'The name of the freelancer/sender',
    category: 'freelancer',
    example: 'Jane Doe',
  },
  {
    key: 'freelancer_email',
    name: 'Freelancer Email',
    description: 'The contact email address of the freelancer',
    category: 'freelancer',
    example: 'jane@example.com',
  },
  {
    key: 'business_name',
    name: 'Business Name',
    description: 'The trading or company name of the freelancer',
    category: 'freelancer',
    example: 'Acme Studios LLC',
  },
  {
    key: 'app_name',
    name: 'Application Name',
    description: 'The platform name',
    category: 'general',
    example: 'LancePay',
  },
  {
    key: 'support_email',
    name: 'Support Email',
    description: 'Platform support email address',
    category: 'general',
    example: 'support@lancepay.com',
  },
]

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const category = searchParams.get('category')?.toLowerCase().trim()

    if (category && !EMAIL_TEMPLATE_CATEGORIES.includes(category as typeof EMAIL_TEMPLATE_CATEGORIES[number])) {
      return NextResponse.json(
        { error: `Invalid category. Must be one of: ${EMAIL_TEMPLATE_CATEGORIES.join(', ')}` },
        { status: 400 },
      )
    }

    const variables = category
      ? EMAIL_TEMPLATE_VARIABLES.filter((v) => v.category === category)
      : EMAIL_TEMPLATE_VARIABLES

    return NextResponse.json({
      variables,
      count: variables.length,
      categories: EMAIL_TEMPLATE_CATEGORIES,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/email-templates/variables error')
    return NextResponse.json({ error: 'Failed to list email template variables' }, { status: 500 })
  }
}
