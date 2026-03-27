import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    // Verify auth
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Parse query parameters
    const { searchParams } = new URL(request.url)
    const q = searchParams.get('q')
    const type = searchParams.get('type')

    // Validate query
    if (!q || q.length < 2) {
      return NextResponse.json({ error: 'Query must be at least 2 characters' }, { status: 400 })
    }

    // Validate type if provided
    if (type && !['invoices', 'bank-accounts'].includes(type)) {
      return NextResponse.json({ error: 'Invalid type. Must be "invoices" or "bank-accounts"' }, { status: 400 })
    }

    // Build queries based on type
    const searchInvoices = !type || type === 'invoices'
    const searchBankAccounts = !type || type === 'bank-accounts'

    // Run queries in parallel
    const [invoices, bankAccounts] = await Promise.all([
      searchInvoices
        ? prisma.invoice.findMany({
            where: {
              userId: user.id,
              OR: [
                { invoiceNumber: { contains: q, mode: 'insensitive' } },
                { clientName: { contains: q, mode: 'insensitive' } },
                { clientEmail: { contains: q, mode: 'insensitive' } },
                { description: { contains: q, mode: 'insensitive' } },
              ],
            },
            take: 10,
            orderBy: { createdAt: 'desc' },
            select: { id: true, invoiceNumber: true, clientName: true, amount: true, status: true },
          })
        : [],
      searchBankAccounts
        ? prisma.bankAccount.findMany({
            where: {
              userId: user.id,
              OR: [
                { bankName: { contains: q, mode: 'insensitive' } },
                { accountName: { contains: q, mode: 'insensitive' } },
                { accountNumber: { contains: q } },
              ],
            },
            take: 10,
          })
        : [],
    ])

    return NextResponse.json({
      query: q,
      results: {
        invoices,
        bankAccounts,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Search error')
    return NextResponse.json({ error: 'Failed to search' }, { status: 500 })
  }
}