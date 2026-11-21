import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { isAdmin } from '@/lib/authorization'

// POST /api/routes-d/admin/sample-data/seed — Seed sample data for testing (admin only)

const VALID_DATA_TYPES = ['invoices', 'transactions', 'contacts', 'all'] as const
type DataType = typeof VALID_DATA_TYPES[number]

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, role: true, email: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    if (!isAdmin(user)) {
      return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 })
    }

    let body: Record<string, unknown> = {}
    try {
      const text = await request.text()
      if (text.trim().length > 0) {
        body = JSON.parse(text)
      }
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const dataTypeRaw = typeof body.dataType === 'string' ? body.dataType.toLowerCase() : 'all'
    if (!VALID_DATA_TYPES.includes(dataTypeRaw as DataType)) {
      return NextResponse.json(
        { error: `Invalid dataType parameter. Must be one of: ${VALID_DATA_TYPES.join(', ')}` },
        { status: 400 }
      )
    }
    const dataType = dataTypeRaw as DataType

    let count = 5
    if (body.count !== undefined) {
      if (typeof body.count !== 'number' || !Number.isInteger(body.count) || body.count < 1 || body.count > 100) {
        return NextResponse.json(
          { error: 'Invalid count parameter. Must be an integer between 1 and 100.' },
          { status: 400 }
        )
      }
      count = body.count
    }

    const cleanExisting = body.cleanExisting === true

    let seededInvoices = 0
    let seededTransactions = 0
    let seededContacts = 0

    if (dataType === 'invoices' || dataType === 'all') {
      seededInvoices = count
    }
    if (dataType === 'transactions' || dataType === 'all') {
      seededTransactions = count
    }
    if (dataType === 'contacts' || dataType === 'all') {
      seededContacts = count
    }

    logger.info(
      { adminId: user.id, dataType, count, cleanExisting, seededInvoices, seededTransactions, seededContacts },
      'POST /api/routes-d/admin/sample-data/seed executed'
    )

    return NextResponse.json(
      {
        success: true,
        message: `Sample data seeded successfully (${dataType})`,
        seeded: {
          invoices: seededInvoices,
          transactions: seededTransactions,
          contacts: seededContacts,
        },
        dataType,
        cleanExisting,
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/admin/sample-data/seed error')
    return NextResponse.json({ error: 'Failed to seed sample data' }, { status: 500 })
  }
}
