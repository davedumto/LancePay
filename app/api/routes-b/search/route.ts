import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { validateSearchQuery } from '../_lib/validation'
import { registerRoute } from '../_lib/openapi'
import { z } from 'zod'

// Register OpenAPI documentation
registerRoute({
  method: 'GET',
  path: '/search',
  summary: 'Search invoices and bank accounts',
  description: 'Search across invoices and bank accounts for the authenticated user.',
  requestSchema: z.object({
    q: z.string().min(1).describe('Search query'),
    type: z.enum(['invoices', 'bank-accounts']).optional().describe('Filter by type')
  }),
  responseSchema: z.object({
    query: z.string(),
    results: z.object({
      invoices: z.array(z.object({
        id: z.string(),
        invoiceNumber: z.string(),
        clientName: z.string().nullable(),
        amount: z.number(),
        status: z.string()
      })),
      bankAccounts: z.array(z.object({
        id: z.string(),
        bankName: z.string(),
        accountName: z.string(),
        accountNumber: z.string(),
        isDefault: z.boolean()
      }))
    })
  }),
  tags: ['search']
})

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const url = new URL(request.url)
    const query = validateSearchQuery(url.searchParams.get('q'))
    const type = url.searchParams.get('type')

    if (!query.ok) {
      return NextResponse.json({ error: query.error }, { status: 400 })
    }

    const q = query.value
    const isInvoicesOnly = type === 'invoices'
    const isBankAccountsOnly = type === 'bank-accounts'
    const isBoth = !type

    if (!isBoth && !isInvoicesOnly && !isBankAccountsOnly) {
      return NextResponse.json(
        { error: 'Invalid "type". Expected "invoices" or "bank-accounts"' },
        { status: 400 }
      )
    }

    const [invoices, bankAccounts] = await Promise.all([
      isBankAccountsOnly
        ? Promise.resolve([])
        : prisma.invoice.findMany({
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
            select: {
              id: true,
              invoiceNumber: true,
              clientName: true,
              amount: true,
              status: true,
            },
          }),
      isInvoicesOnly
        ? Promise.resolve([])
        : prisma.bankAccount.findMany({
            where: {
              userId: user.id,
              OR: [
                { bankName: { contains: q, mode: 'insensitive' } },
                { accountName: { contains: q, mode: 'insensitive' } },
                { accountNumber: { contains: q } },
              ],
            },
            take: 10,
            orderBy: { createdAt: 'desc' },
          }),
    ])

    return NextResponse.json({
      query: q,
      results: {
        invoices,
        bankAccounts,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Routes-B search GET error')
    return NextResponse.json({ error: 'Failed to search records' }, { status: 500 })
  }
}