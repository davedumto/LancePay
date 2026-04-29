import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { sanitizeSearchQuery } from '../../_lib/validation'
import { getSuggestCache, setSuggestCache } from './_lib/cache'

type Suggestion = {
  type: 'invoice' | 'contact' | 'tag'
  id: string
  label: string
  matchedField: 'invoiceNumber' | 'clientName' | 'name'
  createdAt: Date
}

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const url = new URL(request.url)
    const qRaw = url.searchParams.get('q') ?? ''
    const q = sanitizeSearchQuery(qRaw)

    if (q.length < 2 || q.length > 32) {
      return NextResponse.json({ error: 'q must be between 2 and 32 characters' }, { status: 400 })
    }

    const cacheKey = `${user.id}:${q.toLowerCase()}`
    const cached = getSuggestCache(cacheKey)
    if (cached) {
      return NextResponse.json({ suggestions: cached, cache: 'hit' })
    }

    const [invoices, contacts, tags] = await Promise.all([
      prisma.invoice.findMany({
        where: {
          userId: user.id,
          OR: [
            { invoiceNumber: { contains: q, mode: 'insensitive' } },
            { clientName: { contains: q, mode: 'insensitive' } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, invoiceNumber: true, clientName: true, createdAt: true },
      }),
      prisma.contact.findMany({
        where: {
          userId: user.id,
          OR: [{ name: { contains: q, mode: 'insensitive' } }],
        },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, name: true, createdAt: true },
      }),
      prisma.tag.findMany({
        where: {
          userId: user.id,
          name: { contains: q, mode: 'insensitive' },
        },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, name: true, createdAt: true },
      }),
    ])

    const merged: Suggestion[] = [
      ...invoices.map((row) => ({
        type: 'invoice' as const,
        id: row.id,
        label: row.invoiceNumber,
        matchedField: 'invoiceNumber' as const,
        createdAt: row.createdAt,
      })),
      ...contacts.map((row) => ({
        type: 'contact' as const,
        id: row.id,
        label: row.name,
        matchedField: 'name' as const,
        createdAt: row.createdAt,
      })),
      ...tags.map((row) => ({
        type: 'tag' as const,
        id: row.id,
        label: row.name,
        matchedField: 'name' as const,
        createdAt: row.createdAt,
      })),
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 8)
      .map(({ createdAt, ...rest }) => rest)

    setSuggestCache(cacheKey, merged)
    return NextResponse.json({ suggestions: merged, cache: 'miss' })
  } catch (error) {
    logger.error({ err: error }, 'Routes-B search suggest GET error')
    return NextResponse.json({ error: 'Failed to fetch suggestions' }, { status: 500 })
  }
}
