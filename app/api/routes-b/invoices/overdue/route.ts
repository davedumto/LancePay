import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { Invoice } from '@prisma/client'
import { verifyAuthToken } from '@/lib/auth'
import { computeLateFee } from '../../_lib/late-fee' // Issue #599

async function GETHandler(request: NextRequest) {
  // 1. Verify auth
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const now = new Date()
  const { searchParams } = new URL(request.url)
  const withLateFee = searchParams.get('withLateFee') === 'true' // Issue #599

  // 2. Fetch overdue invoices
  // An invoice is overdue when status is 'pending' and dueDate < now
  const overdueInvoices = await prisma.invoice.findMany({
    where: {
      userId: user.id,
      status: 'pending',
      dueDate: {
        not: null,
        lt: now,
      },
    },
    orderBy: { dueDate: 'asc' }, // most overdue first
  })

  // 3. Format response and compute daysOverdue
  const invoices = overdueInvoices.map((inv: Invoice) => {
    // Math.floor((now - dueDate) / ms_per_day)
    const daysOverdue = Math.floor(
      (now.getTime() - inv.dueDate!.getTime()) / (1000 * 60 * 60 * 24)
    )

    const base = {
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      clientName: inv.clientName,
      clientEmail: inv.clientEmail,
      amount: Number(inv.amount),
      dueDate: inv.dueDate,
      daysOverdue: Math.max(0, daysOverdue), // Ensure non-negative
    }

    if (withLateFee) {
      const fee = computeLateFee(
        { amount: Number(inv.amount), currency: inv.currency, dueDate: inv.dueDate },
        now,
      )
      return { ...base, lateFee: fee }
    }

    return base
  })

  // 4. Return results
  return NextResponse.json({
    invoices,
    total: invoices.length,
  })
}

export const GET = withRequestId(GETHandler)
