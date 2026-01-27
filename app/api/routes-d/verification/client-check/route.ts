import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import {
  classifyDomain,
  getDomainFromEmail,
  MIN_PAID_INVOICES_FOR_VERIFIED,
} from '@/app/api/routes-d/verification/_shared'

/** Cache validity: re-compute reputation after 24 hours */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export async function GET(request: NextRequest) {
  try {
    const rawEmail = request.nextUrl.searchParams.get('email')
    const email = rawEmail?.trim().toLowerCase()
    if (!email) {
      return NextResponse.json({ error: 'email query parameter is required' }, { status: 400 })
    }
    // Basic email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Invalid email format' }, { status: 400 })
    }

    const domain = getDomainFromEmail(email)
    if (!domain) {
      return NextResponse.json({ error: 'Invalid email' }, { status: 400 })
    }

    const domainType = classifyDomain(domain)

    // Check cache: same email, recently updated
    const cached = await prisma.clientReputation.findUnique({
      where: { clientEmail: email },
    })
    const now = new Date()
    const cacheExpired = cached ? now.getTime() - cached.lastCheckedAt.getTime() > CACHE_TTL_MS : true

    if (cached && !cacheExpired) {
      return NextResponse.json({
        clientEmail: email,
        domainType: cached.domainType ?? domainType,
        paymentScore: cached.paymentScore,
        isVerified: cached.isVerified,
        totalPaidCount: cached.paymentScore, // payment_score is the successful-invoice count
        lastCheckedAt: cached.lastCheckedAt.toISOString(),
      })
    }

    // Aggregate payment history: paid invoices where this email is the client
    // Exclude disputed/refunded by counting status = 'paid' only (disputed/refunded have different statuses)
    const paidInvoices = await prisma.invoice.findMany({
      where: {
        clientEmail: { equals: email, mode: 'insensitive' },
        status: 'paid',
      },
      select: { id: true, amount: true },
    })

    const totalPaidCount = paidInvoices.length
    const totalPaidAmount = paidInvoices.reduce((sum, inv) => sum + Number(inv.amount), 0)

    // Payment score = number of successful (paid) invoices
    const paymentScore = totalPaidCount

    // Verified: corporate domain OR 3+ successful payments without disputes
    const isVerified =
      domainType === 'corporate' || (domainType !== 'disposable' && paymentScore >= MIN_PAID_INVOICES_FOR_VERIFIED)

    await prisma.clientReputation.upsert({
      where: { clientEmail: email },
      create: {
        clientEmail: email,
        domainType,
        paymentScore,
        isVerified,
        lastCheckedAt: now,
      },
      update: {
        domainType,
        paymentScore,
        isVerified,
        lastCheckedAt: now,
      },
    })

    return NextResponse.json({
      clientEmail: email,
      domainType,
      paymentScore,
      isVerified,
      totalPaidCount,
      totalPaidAmount: Math.round((totalPaidAmount + Number.EPSILON) * 100) / 100,
      lastCheckedAt: now.toISOString(),
    })
  } catch (error) {
    console.error('Verification client-check error:', error)
    return NextResponse.json({ error: 'Verification check failed' }, { status: 500 })
  }
}
