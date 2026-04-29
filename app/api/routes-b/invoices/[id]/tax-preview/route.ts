import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { computeTax } from '../../../_lib/tax'

async function GETHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const claims = await verifyAuthToken(authToken)
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    select: { id: true, userId: true, amount: true, currency: true },
  })
  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  if (invoice.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = new URL(request.url)
  const region = searchParams.get('region') ?? 'US'
  const type = searchParams.get('type') ?? 'standard'

  const subtotal = Number(invoice.amount)
  const tax = computeTax(subtotal, region, type)

  return NextResponse.json({
    invoiceId: invoice.id,
    currency: invoice.currency,
    subtotal,
    ...tax,
  })
}

export const GET = withRequestId(GETHandler)
