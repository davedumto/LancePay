import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const SUPPORTED_TEMPLATE_CURRENCIES = new Set([
  'USD',
  'USDC',
  'EUR',
  'GBP',
  'NGN',
  'KES',
  'GHS',
  'ZAR',
  'CAD',
  'AUD',
] as const)

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  )
}

async function resolveAuthenticatedUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  let userId = claims.userId
  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser =
      (await prisma.user.findUnique({
        where: { privyId: claims.userId },
        select: { id: true },
      })) ??
      (await prisma.user.findUnique({
        where: { id: claims.userId },
        select: { id: true },
      }))

    if (!dbUser) {
      return { error: 'User not found', status: 404 as const, user: null }
    }
    userId = dbUser.id
  }

  return { error: null, status: 200 as const, user: { id: userId } }
}

function generateInvoiceNumberAndLink() {
  const suffix = randomBytes(4).toString('hex').toUpperCase()
  const invoiceNumber = `INV-TPL-${suffix}`
  const paymentLink = `https://pay.lancepay.io/i/${suffix.toLowerCase()}`
  return { invoiceNumber, paymentLink }
}

async function instantiateInvoiceFromTemplate(params: {
  userId: string
  template: {
    id: string
    name: string
    clientEmail?: string | null
    clientName?: string | null
    description: string
    amount: unknown
    currency: string
  }
  overrideClientEmail?: string | null
  overrideClientName?: string | null
  dueDate?: Date | null
}) {
  const clientEmail = (
    params.overrideClientEmail ??
    params.template.clientEmail ??
    ''
  ).trim()

  if (!clientEmail) {
    return {
      error:
        'clientEmail is required (either on the template or in the request) to instantiate an invoice',
      code: 'CLIENT_EMAIL_REQUIRED_FOR_INSTANTIATION',
      status: 400 as const,
      invoice: null,
    }
  }

  const { invoiceNumber, paymentLink } = generateInvoiceNumberAndLink()
  const createdInvoice = await prisma.invoice.create({
    data: {
      userId: params.userId,
      invoiceNumber,
      clientEmail,
      clientName:
        params.overrideClientName ?? params.template.clientName ?? null,
      description: params.template.description,
      amount: Number(params.template.amount),
      currency: params.template.currency,
      status: 'pending',
      paymentLink,
      ...(params.dueDate ? { dueDate: params.dueDate } : {}),
    },
  })

  return {
    error: null,
    code: null,
    status: 201 as const,
    invoice: createdInvoice,
  }
}

/**
 * GET /api/invoice-templates
 * Lists saved `InvoiceTemplate` records belonging to the authenticated user.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const templates = await prisma.invoiceTemplate.findMany({
      where: { userId: auth.user.id },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      templates,
      total: templates.length,
    })
  } catch (err) {
    logger?.error?.({ err }, 'GET /api/invoice-templates error')
    return NextResponse.json(
      { error: 'Failed to list invoice templates' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/invoice-templates
 * Creates a reusable `InvoiceTemplate` (or instantiates an `Invoice` from a saved template):
 * - Enforces the unique `(userId, name)` constraint with a clean `409` on collision.
 * - Validates `amount` is positive (`> 0`) and `currency` is in `SUPPORTED_TEMPLATE_CURRENCIES`.
 * - Supports instantiating a new invoice from a saved template (`action: 'instantiate'` / `templateId` or `instantiate: true`).
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid JSON request body' },
        { status: 400 },
      )
    }

    // Mode A: Instantiate an invoice directly from an existing saved templateId
    const isDirectInstantiate =
      body.action === 'instantiate' ||
      (typeof body.templateId === 'string' &&
        body.templateId.trim() !== '' &&
        !body.name)

    if (isDirectInstantiate) {
      const templateId =
        typeof body.templateId === 'string' ? body.templateId.trim() : ''
      if (!templateId) {
        return NextResponse.json(
          {
            error: 'templateId is required to instantiate an invoice',
            code: 'TEMPLATE_ID_REQUIRED',
          },
          { status: 400 },
        )
      }

      const existingTemplate = await prisma.invoiceTemplate.findUnique({
        where: { id: templateId },
      })

      if (!existingTemplate) {
        return NextResponse.json(
          { error: 'Invoice template not found', code: 'TEMPLATE_NOT_FOUND' },
          { status: 404 },
        )
      }

      if (existingTemplate.userId !== auth.user.id) {
        return NextResponse.json(
          {
            error: 'Forbidden: template belongs to another user',
            code: 'FORBIDDEN_TEMPLATE_OWNER',
          },
          { status: 403 },
        )
      }

      const instantiated = await instantiateInvoiceFromTemplate({
        userId: auth.user.id,
        template: existingTemplate,
        overrideClientEmail:
          typeof body.clientEmail === 'string' ? body.clientEmail : null,
        overrideClientName:
          typeof body.clientName === 'string' ? body.clientName : null,
        dueDate: body.dueDate ? new Date(body.dueDate) : null,
      })

      if (instantiated.error || !instantiated.invoice) {
        return NextResponse.json(
          { error: instantiated.error, code: instantiated.code },
          { status: instantiated.status },
        )
      }

      return NextResponse.json(
        {
          instantiated: true,
          template: existingTemplate,
          invoice: instantiated.invoice,
        },
        { status: 201 },
      )
    }

    // Mode B: Create a new InvoiceTemplate (with optional immediate instantiation)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name || name.length > 150) {
      return NextResponse.json(
        {
          error: 'name is required and must be at most 150 characters',
          code: 'INVALID_TEMPLATE_NAME',
        },
        { status: 400 },
      )
    }

    const description =
      typeof body.description === 'string' ? body.description.trim() : ''
    if (!description) {
      return NextResponse.json(
        {
          error: 'description is required',
          code: 'INVALID_TEMPLATE_DESCRIPTION',
        },
        { status: 400 },
      )
    }

    const amount =
      typeof body.amount === 'number' ? body.amount : Number(body.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        {
          error: 'amount must be a positive number greater than 0',
          code: 'INVALID_TEMPLATE_AMOUNT',
        },
        { status: 400 },
      )
    }

    const currency =
      typeof body.currency === 'string' && body.currency.trim()
        ? body.currency.trim().toUpperCase()
        : 'USD'
    if (
      !SUPPORTED_TEMPLATE_CURRENCIES.has(
        currency as typeof SUPPORTED_TEMPLATE_CURRENCIES extends Set<infer T>
          ? T
          : never,
      )
    ) {
      return NextResponse.json(
        {
          error: `Unsupported currency. Supported currencies: ${Array.from(SUPPORTED_TEMPLATE_CURRENCIES).join(', ')}`,
          code: 'UNSUPPORTED_CURRENCY',
        },
        { status: 400 },
      )
    }

    const clientEmail =
      typeof body.clientEmail === 'string' && body.clientEmail.trim()
        ? body.clientEmail.trim()
        : null
    const clientName =
      typeof body.clientName === 'string' && body.clientName.trim()
        ? body.clientName.trim()
        : null

    // Check for duplicate (userId, name) before creating
    if (typeof prisma.invoiceTemplate?.findUnique === 'function') {
      const collision = await prisma.invoiceTemplate.findUnique({
        where: {
          userId_name: {
            userId: auth.user.id,
            name,
          },
        },
      })
      if (collision) {
        return NextResponse.json(
          {
            error: `An invoice template named '${name}' already exists`,
            code: 'TEMPLATE_NAME_ALREADY_EXISTS',
          },
          { status: 409 },
        )
      }
    }

    let createdTemplate
    try {
      createdTemplate = await prisma.invoiceTemplate.create({
        data: {
          userId: auth.user.id,
          name,
          clientEmail,
          clientName,
          description,
          amount,
          currency,
        },
      })
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return NextResponse.json(
          {
            error: `An invoice template named '${name}' already exists`,
            code: 'TEMPLATE_NAME_ALREADY_EXISTS',
          },
          { status: 409 },
        )
      }
      throw err
    }

    const shouldInstantiate =
      body.instantiate === true || body.instantiateInvoice === true

    if (shouldInstantiate) {
      const instantiated = await instantiateInvoiceFromTemplate({
        userId: auth.user.id,
        template: createdTemplate,
        overrideClientEmail: clientEmail,
        overrideClientName: clientName,
        dueDate: body.dueDate ? new Date(body.dueDate) : null,
      })

      if (instantiated.error || !instantiated.invoice) {
        return NextResponse.json(
          { error: instantiated.error, code: instantiated.code },
          { status: instantiated.status },
        )
      }

      return NextResponse.json(
        {
          template: createdTemplate,
          instantiated: true,
          invoice: instantiated.invoice,
        },
        { status: 201 },
      )
    }

    return NextResponse.json(
      {
        template: createdTemplate,
      },
      { status: 201 },
    )
  } catch (err) {
    logger?.error?.({ err }, 'POST /api/invoice-templates error')
    return NextResponse.json(
      { error: 'Failed to save invoice template' },
      { status: 500 },
    )
  }
}
