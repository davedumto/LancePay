import { NextRequest, NextResponse } from 'next/server'
import type { AuthTokenClaims } from '@privy-io/server-auth'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { createInvoiceSchema } from '@/lib/validations'
import { generateInvoiceNumber } from '@/lib/utils'
import { logAuditEvent, extractRequestMetadata } from '@/lib/audit'
import { logger } from '@/lib/logger'

async function getOrCreateUser(claims: AuthTokenClaims, referralCode?: string) {
  let user = await prisma.user.findUnique({ where: { privyId: claims.userId } })

  if (!user) {
    const email = (claims as { email?: string }).email || `${claims.userId}@privy.local`
    const data: { privyId: string; email: string; referredById?: string } = {
      privyId: claims.userId,
      email
    }

    if (referralCode) {
      const referrer = await (prisma.user as any).findUnique({
        where: { referralCode },
        select: { id: true }
      })
      if (referrer) {
        data.referredById = referrer.id
      }
    }

    user = await (prisma.user as any).create({ data })
  }

  return user as any
}

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await getOrCreateUser(claims)

    const invoices = await prisma.invoice.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ invoices })
  } catch (error) {
    logger.error({ err: error }, 'Invoices GET error:')
    return NextResponse.json({ error: 'Failed to get invoices' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await getOrCreateUser(claims)

    const body = await request.json()
    const parsed = createInvoiceSchema.safeParse(body)
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 })

    const { clientEmail, clientName, description, amount, currency, dueDate } = parsed.data
    const invoiceNumber = generateInvoiceNumber()
    const paymentLink = `${process.env.NEXT_PUBLIC_APP_URL}/pay/${invoiceNumber}`

    // Auto-link to existing client user if email matches
    const existingClient = await prisma.user.findUnique({
      where: { email: clientEmail },
      select: { id: true }
    })

    const invoice = await (prisma as any).invoice.create({
      data: {
        userId: user.id,
        invoiceNumber,
        clientEmail,
        clientName,
        description,
        amount,
        currency,
        dueDate: dueDate ? new Date(dueDate) : null,
        paymentLink,
        clientId: existingClient?.id || null
      },
    })

    // Log audit event
    await logAuditEvent(invoice.id, 'invoice.created', user.id, extractRequestMetadata(request.headers))

    return NextResponse.json(invoice, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'Invoices POST error:')
    return NextResponse.json({ error: 'Failed to create invoice' }, { status: 500 })
  }
}
