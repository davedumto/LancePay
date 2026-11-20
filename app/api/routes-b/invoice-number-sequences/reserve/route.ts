import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'
import { logger } from '@/lib/logger'

// POST /api/routes-b/invoice-number-sequences/reserve — reserve an invoice number

const PREFIX_REGEX = /^[A-Za-z0-9_-]{1,20}$/

export async function POST(request: NextRequest) {
  try {
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
      select: { id: true },
    })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    let body: unknown = {}
    try {
      const text = await request.text()
      if (text.trim()) {
        body = JSON.parse(text)
      }
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as Record<string, unknown>
    const prefix = payload.prefix !== undefined ? payload.prefix : 'INV'

    if (prefix !== null && typeof prefix !== 'string') {
      return NextResponse.json(
        { error: 'prefix must be a string if provided' },
        { status: 400 },
      )
    }

    if (typeof prefix === 'string' && prefix.trim()) {
      if (!PREFIX_REGEX.test(prefix.trim())) {
        return NextResponse.json(
          { error: 'prefix must be 1-20 alphanumeric characters, hyphens, or underscores' },
          { status: 400 },
        )
      }
    }

    const activePrefix = typeof prefix === 'string' && prefix.trim() ? prefix.trim().toUpperCase() : 'INV'

    let invoiceNumber = ''
    let isUnique = false
    let attempts = 0

    while (!isUnique && attempts < 10) {
      attempts++
      if (activePrefix === 'INV') {
        invoiceNumber = generateInvoiceNumber()
      } else {
        const ts = Date.now().toString(36).toUpperCase()
        const bytes = new Uint8Array(2)
        globalThis.crypto.getRandomValues(bytes)
        const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
          .join('')
          .toUpperCase()
        invoiceNumber = `${activePrefix}-${ts}-${rand}`
      }

      const existing = await prisma.invoice.findUnique({
        where: { invoiceNumber },
        select: { id: true },
      })

      if (!existing) {
        isUnique = true
      }
    }

    if (!isUnique) {
      return NextResponse.json(
        { error: 'Failed to generate unique invoice number' },
        { status: 500 },
      )
    }

    const now = new Date()
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000) // 24 hours reservation window

    return NextResponse.json(
      {
        invoiceNumber,
        prefix: activePrefix,
        reservedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        userId: user.id,
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/invoice-number-sequences/reserve error')
    return NextResponse.json(
      { error: 'Failed to reserve invoice number' },
      { status: 500 },
    )
  }
}
