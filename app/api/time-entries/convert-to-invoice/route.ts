import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'
import { convertTimeEntriesSchema } from '@/lib/validations'

/**
 * POST /api/time-entries/convert-to-invoice
 *
 * Aggregates a set of unbilled TimeEntry rows into invoice line items, creates
 * an invoice, and marks the entries billed. Entries already billed are rejected
 * to prevent double-billing, and the mark-billed update happens in the same
 * transaction as invoice creation so a failure never leaves entries in an
 * inconsistent state.
 */
export async function POST(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = convertTimeEntriesSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const { timeEntryIds, clientEmail, clientName, currency, dueDate } = parsed.data
  const uniqueIds = Array.from(new Set(timeEntryIds))

  const entries = await prisma.timeEntry.findMany({
    where: { id: { in: uniqueIds }, userId: user.id },
    include: { project: { select: { id: true, title: true } } },
  })

  // Every requested entry must exist and belong to the caller.
  if (entries.length !== uniqueIds.length) {
    return NextResponse.json(
      { error: 'One or more time entries were not found' },
      { status: 404 },
    )
  }

  // Reject entries already billed (by status or by an existing invoice link) to
  // prevent double-billing the same hours.
  const alreadyBilled = entries.filter(
    (entry) => entry.status === 'billed' || entry.invoiceId !== null,
  )
  if (alreadyBilled.length > 0) {
    return NextResponse.json(
      {
        error: 'One or more time entries are already billed',
        details: { timeEntryIds: alreadyBilled.map((entry) => entry.id) },
      },
      { status: 409 },
    )
  }

  // Group entries by project and rate so each distinct rate becomes its own
  // line item with a summed quantity.
  interface LineGroup {
    projectId: string | null
    projectTitle: string | null
    rate: number
    hours: number
  }
  const lineGroups = new Map<string, LineGroup>()

  for (const entry of entries) {
    const rate = Number(entry.rateUsdc)
    const projectId = entry.project?.id ?? null
    const key = `${projectId ?? '__none__'}::${rate}`
    const existing = lineGroups.get(key)
    if (existing) {
      existing.hours += Number(entry.hours)
    } else {
      lineGroups.set(key, {
        projectId,
        projectTitle: entry.project?.title ?? null,
        rate,
        hours: Number(entry.hours),
      })
    }
  }

  const lineItems = Array.from(lineGroups.values()).map((group, index) => {
    const quantity = Number(group.hours.toFixed(2))
    const unitPrice = Number(group.rate.toFixed(2))
    return {
      description: group.projectTitle
        ? `${group.projectTitle} - billable hours`
        : 'Billable hours',
      quantity,
      unitPrice,
      position: index,
      amount: quantity * unitPrice,
    }
  })

  const totalAmount = Number(
    lineItems.reduce((sum, item) => sum + item.amount, 0).toFixed(2),
  )

  const invoiceNumber = generateInvoiceNumber()
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${request.headers.get('host')}`
  const paymentLink = `${baseUrl}/pay/${invoiceNumber}`

  const description = `Time entries (${entries.length}) converted to invoice`

  // Create the invoice, its line items, and mark the entries billed atomically.
  const invoice = await prisma.$transaction(async (tx) => {
    const createdInvoice = await tx.invoice.create({
      data: {
        userId: user.id,
        invoiceNumber,
        clientEmail: clientEmail.toLowerCase(),
        clientName: clientName ?? null,
        description,
        amount: totalAmount,
        currency,
        paymentLink,
        dueDate: dueDate ? new Date(dueDate) : null,
        lineItems: {
          create: lineItems.map((item) => ({
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            position: item.position,
          })),
        },
      },
    })

    await tx.timeEntry.updateMany({
      where: { id: { in: uniqueIds }, userId: user.id },
      data: { status: 'billed', invoiceId: createdInvoice.id },
    })

    return createdInvoice
  })

  return NextResponse.json(
    {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      paymentLink: invoice.paymentLink,
      status: invoice.status,
      amount: Number(invoice.amount),
      currency: invoice.currency,
      lineItemCount: lineItems.length,
      convertedEntryCount: entries.length,
    },
    { status: 201 },
  )
}
