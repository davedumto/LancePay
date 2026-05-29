import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { badRequest, unauthorized, notFound } from '../_shared/error'

/**
 * GET /api/routes-d/search?q=term&type=invoices|contacts&typeahead=true
 *
 * Search across the authenticated user's invoices and contacts.
 * Returns up to 10 results per resource type, ordered by most recent first.
 * With typeahead=true, returns ranked short suggestions for autocomplete.
 */
export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return unauthorized()
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
  })
  if (!user) {
    return notFound('User not found')
  }

  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q')
  const type = searchParams.get('type')
  const isTypeahead = searchParams.get('typeahead') === 'true'

  const minLength = isTypeahead ? 1 : 2
  if (!q || q.length < minLength) {
    return badRequest(
      `Query parameter "q" is required and must be at least ${minLength} character${minLength > 1 ? 's' : ''}`
    )
  }

  const searchInvoices = !type || type === 'invoices'
  const searchContacts = !type || type === 'contacts'

  if (isTypeahead) {
    const [invoiceNumbers, clientNames, clientEmails] = await Promise.all([
      searchInvoices
        ? prisma.invoice.findMany({
            where: {
              userId: user.id,
              invoiceNumber: { contains: q, mode: 'insensitive' },
            },
            take: 5,
            orderBy: { createdAt: 'desc' },
            select: { invoiceNumber: true },
          })
        : Promise.resolve([]),
      searchContacts
        ? prisma.invoice.findMany({
            where: {
              userId: user.id,
              clientName: { contains: q, mode: 'insensitive' },
            },
            distinct: ['clientName'],
            take: 5,
            orderBy: { createdAt: 'desc' },
            select: { clientName: true },
          })
        : Promise.resolve([]),
      searchContacts
        ? prisma.invoice.findMany({
            where: {
              userId: user.id,
              clientEmail: { contains: q, mode: 'insensitive' },
            },
            distinct: ['clientEmail'],
            take: 5,
            orderBy: { createdAt: 'desc' },
            select: { clientEmail: true },
          })
        : Promise.resolve([]),
    ])

    const suggestions = [
      ...invoiceNumbers.map((inv) => inv.invoiceNumber),
      ...clientNames.filter(Boolean).map((c) => c.clientName),
      ...clientEmails.filter(Boolean).map((c) => c.clientEmail),
    ].slice(0, 10)

    return NextResponse.json({
      query: q,
      suggestions,
      typeahead: true,
    })
  }

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
