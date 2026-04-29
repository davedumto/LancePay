import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    const savedSearch = await (prisma as any).savedSearch.findFirst({
      where: { id, userId: user.id },
    })

    if (!savedSearch) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const q: string = savedSearch.query
    const filters = savedSearch.filters as { type?: string } | null
    const filterType = filters?.type as
      | 'invoices'
      | 'bank-accounts'
      | 'contacts'
      | 'tags'
      | null
      | undefined

    const [invoices, bankAccounts, contacts, tags] = await Promise.all([
      filterType && filterType !== 'invoices'
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
      filterType && filterType !== 'bank-accounts'
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
      filterType && filterType !== 'contacts'
        ? Promise.resolve([])
        : prisma.contact.findMany({
            where: {
              userId: user.id,
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { email: { contains: q, mode: 'insensitive' } },
                { company: { contains: q, mode: 'insensitive' } },
              ],
            },
            take: 10,
            orderBy: { createdAt: 'desc' },
          }),
      filterType && filterType !== 'tags'
        ? Promise.resolve([])
        : prisma.tag.findMany({
            where: { userId: user.id, name: { contains: q, mode: 'insensitive' } },
            take: 10,
            orderBy: { createdAt: 'desc' },
          }),
    ])

    return NextResponse.json({
      query: q,
      savedSearchId: id,
      results: { invoices, bankAccounts, contacts, tags },
      facets: {
        types: {
          invoice: invoices.length,
          bankAccount: bankAccounts.length,
          contact: contacts.length,
          tag: tags.length,
        },
        statuses: {},
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Routes-B saved search run error')
    return NextResponse.json({ error: 'Failed to run saved search' }, { status: 500 })
  }
}
