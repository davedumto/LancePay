import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

/**
 * GET /api/routes-d/search?q=term&type=invoices|contacts
 *
 * Search across the authenticated user's invoices and contacts.
 * Returns up to 10 results per resource type, ordered by most recent first.
 */
export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
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

  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q')
  const type = searchParams.get('type') // "invoices" | "contacts" | null (both)

  if (!q || q.length < 2) {
    return NextResponse.json(
      { error: 'Query parameter "q" is required and must be at least 2 characters' },
      { status: 400 }
    )
  }

  const searchInvoices = !type || type === 'invoices'
  const searchContacts = !type || type === 'contacts'

  const [invoices, contacts] = await Promise.all([
    searchInvoices
      ? prisma.invoice.findMany({
          where: {
            userId: user.id,
            OR: [
              { invoiceNumber: { contains: q, mode: 'insensitive' } },
              { clientEmail: { contains: q, mode: 'insensitive' } },
              { clientName: { contains: q, mode: 'insensitive' } },
              { description: { contains: q, mode: 'insensitive' } },
            ],
          },
          take: 10,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            invoiceNumber: true,
            clientName: true,
            clientEmail: true,
            amount: true,
            status: true,
            createdAt: true,
          },
        })
      : Promise.resolve([]),
    searchContacts
      ? prisma.invoice.findMany({
          where: {
            userId: user.id,
            OR: [
              { clientEmail: { contains: q, mode: 'insensitive' } },
              { clientName: { contains: q, mode: 'insensitive' } },
            ],
          },
          distinct: ['clientEmail'],
          take: 10,
          orderBy: { createdAt: 'desc' },
          select: {
            clientName: true,
            clientEmail: true,
          },
        })
      : Promise.resolve([]),
  ])

  return NextResponse.json({
    query: q,
    results: {
      invoices,
      contacts,
    },
    totalResults: invoices.length + contacts.length,
  })
}
