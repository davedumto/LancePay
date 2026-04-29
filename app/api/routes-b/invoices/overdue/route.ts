import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { Invoice } from '@prisma/client'
import { verifyAuthToken } from '@/lib/auth'

import {
  emptyAgeingBuckets,
  getAgeingBucket,
  getDaysOverdueUtc,
} from '../../_lib/ageing'

import {
  getArchiveFilter,
  parseIncludeArchivedParam,
} from '../../_lib/invoice-archive'

import { computeLateFee } from '../../_lib/late-fee'

async function GETHandler(request: NextRequest) {
  // 1. Auth
  const authToken = request.headers
    .get('authorization')
    ?.replace('Bearer ', '')

  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
  })

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // 2. Query params
  const { searchParams } = new URL(request.url)

  const includeArchived = parseIncludeArchivedParam(
    searchParams.get('includeArchived')
  )

  const bucketed = searchParams.get('bucketed') === 'true'
  const withLateFee = searchParams.get('withLateFee') === 'true'

  const now = new Date()

  // 3. Fetch overdue invoices
  const overdueInvoices = await prisma.invoice.findMany({
    where: {
      userId: user.id,
      status: 'pending',
      ...getArchiveFilter(includeArchived),
      dueDate: {
        not: null,
        lt: now,
      },
    },
    orderBy: { dueDate: 'asc' },
  })

  // 4. Transform
  const invoices = overdueInvoices.map((inv: Invoice) => {
    const daysOverdue = getDaysOverdueUtc(inv.dueDate!, now)

    const base = {
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      clientName: inv.clientName,
      clientEmail: inv.clientEmail,
      amount: Number(inv.amount),
      dueDate: inv.dueDate,
      daysOverdue,
    }

    if (withLateFee) {
      const lateFee = computeLateFee(
        {
          amount: Number(inv.amount),
          currency: inv.currency,
          dueDate: inv.dueDate,
        },
        now
      )

      return { ...base, lateFee }
    }

    return base
  })

  // 5. Non-bucketed response
  if (!bucketed) {
    return NextResponse.json({
      invoices,
      total: invoices.length,
    })
  }

  // 6. Bucketed response
  const buckets = emptyAgeingBuckets<typeof invoices[number]>()

  const totals = {
    '1_30': { count: 0, amount: 0 },
    '31_60': { count: 0, amount: 0 },
    '61_90': { count: 0, amount: 0 },
    '90_plus': { count: 0, amount: 0 },
  }

  for (const invoice of invoices) {
    const key = getAgeingBucket(invoice.daysOverdue)

    buckets[key].push(invoice)

    totals[key].count += 1
    totals[key].amount += invoice.amount
  }

  return NextResponse.json({
    buckets,
    totals,
  })
}

export const GET = withRequestId(GETHandler)