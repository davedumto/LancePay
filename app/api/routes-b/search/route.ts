import { withRequestId } from '../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { validateSearchQuery } from '../_lib/validation'
import { registerRoute } from '../_lib/openapi'
import { getCachedValue, setCachedValue } from '../_lib/cache'
import { errorResponse } from '../_lib/errors'
import { z } from 'zod'

// Register OpenAPI documentation
registerRoute({
  method: 'GET',
  path: '/search',
  summary: 'Search invoices, bank accounts, contacts and tags',
  description:
    'Search across multiple resources for the authenticated user with facet counts.',
  requestSchema: z.object({
    q: z.string().min(1).describe('Search query'),
    type: z
      .enum(['invoices', 'bank-accounts', 'contacts', 'tags'])
      .optional()
      .describe('Filter by type'),
  }),
  responseSchema: z.object({
    query: z.string(),
    results: z.object({
      invoices: z.array(z.any()),
      bankAccounts: z.array(z.any()),
      contacts: z.array(z.any()),
      tags: z.array(z.any()),
    }),
    facets: z.object({
      types: z.object({
        invoice: z.number(),
        bankAccount: z.number(),
        contact: z.number(),
        tag: z.number(),
      }),
      statuses: z.record(z.number()),
    }),
  }),
  tags: ['search'],
})

type Facets = {
  types: {
    invoice: number
    bankAccount: number
    contact: number
    tag: number
  }
  statuses: Record<string, number>
}

async function GETHandler(request: NextRequest) {
  try {
    const requestId = request.headers.get('x-request-id')
    const authToken = request.headers
      .get('authorization')
      ?.replace('Bearer ', '')
    if (!authToken)
      return errorResponse(
        'UNAUTHORIZED',
        'Unauthorized',
        undefined,
        401,
        requestId,
      )

    const claims = await verifyAuthToken(authToken)
    if (!claims)
      return errorResponse(
        'UNAUTHORIZED',
        'Invalid token',
        undefined,
        401,
        requestId,
      )

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    })
    if (!user)
      return errorResponse(
        'NOT_FOUND',
        'User not found',
        undefined,
        404,
        requestId,
      )

    const url = new URL(request.url)
    const query = validateSearchQuery(url.searchParams.get('q'))
    const type = url.searchParams.get('type')

    if (!query.ok) {
      return errorResponse(
        'BAD_REQUEST',
        query.error,
        undefined,
        400,
        requestId,
      )
    }

    const q = query.value
    const filterType = type as
      | 'invoices'
      | 'bank-accounts'
      | 'contacts'
      | 'tags'
      | null

    const cacheKey = `facet:user:${user.id}:q:${q}`
    let facets = getCachedValue<Facets>(cacheKey)

    const [invoices, bankAccounts, contacts, tags, facetData] =
      await Promise.all([
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
            where: {
              userId: user.id,
              name: { contains: q, mode: 'insensitive' },
            },
            take: 10,
            orderBy: { createdAt: 'desc' },
          }),
        facets
          ? Promise.resolve(null)
          : Promise.all([
            prisma.invoice.count({
              where: {
                userId: user.id,
                OR: [
                  { invoiceNumber: { contains: q, mode: 'insensitive' } },
                  { clientName: { contains: q, mode: 'insensitive' } },
                  { clientEmail: { contains: q, mode: 'insensitive' } },
                ],
              },
            }),
            prisma.bankAccount.count({
              where: {
                userId: user.id,
                OR: [
                  { bankName: { contains: q, mode: 'insensitive' } },
                  { accountName: { contains: q, mode: 'insensitive' } },
                ],
              },
            }),
            prisma.contact.count({
              where: {
                userId: user.id,
                OR: [
                  { name: { contains: q, mode: 'insensitive' } },
                  { email: { contains: q, mode: 'insensitive' } },
                ],
              },
            }),
            prisma.tag.count({
              where: {
                userId: user.id,
                name: { contains: q, mode: 'insensitive' },
              },
            }),
            prisma.invoice.groupBy({
              by: ['status'],
              where: {
                userId: user.id,
                OR: [
                  { invoiceNumber: { contains: q, mode: 'insensitive' } },
                  { clientName: { contains: q, mode: 'insensitive' } },
                  { clientEmail: { contains: q, mode: 'insensitive' } },
                ],
              },
              _count: true,
            }),
          ]),
      ])

    if (!facets && facetData) {
      const [invCount, bankCount, contactCount, tagCount, statusGroups] =
        facetData
      const statuses: Record<string, number> = {}
      statusGroups.forEach(group => {
        statuses[group.status] = group._count
      })

      facets = {
        types: {
          invoice: invCount,
          bankAccount: bankCount,
          contact: contactCount,
          tag: tagCount,
        },
        statuses,
      }
      setCachedValue(cacheKey, facets, 30_000)
    }

    return NextResponse.json({
      query: q,
      results: {
        invoices,
        bankAccounts,
        contacts,
        tags,
      },
      facets: facets || {
        types: { invoice: 0, bankAccount: 0, contact: 0, tag: 0 },
        statuses: {},
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Routes-B search GET error')
    return errorResponse(
      'INTERNAL',
      'Failed to search records',
      undefined,
      500,
      request.headers.get('x-request-id'),
    )
  }
}

export const GET = withRequestId(GETHandler)
