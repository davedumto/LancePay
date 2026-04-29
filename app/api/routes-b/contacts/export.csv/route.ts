import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { createCsvStream } from '../../_lib/csv-stream'
import type { Prisma } from '@prisma/client'

const EXPORT_MAX_ROWS = 100_000

type ContactCsvRow = {
  id: string
  name: string
  email: string
  company: string | null
  notes: string | null
  createdAt: Date
  updatedAt: Date
}

async function GETHandler(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const { searchParams } = new URL(request.url)
  const search = searchParams.get('search')

  const where: Prisma.ContactWhereInput = {
    userId: user.id,
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const total = await prisma.contact.count({ where })
  if (total > EXPORT_MAX_ROWS) {
    return NextResponse.json(
      { error: `Export exceeds ${EXPORT_MAX_ROWS} rows` },
      { status: 413 },
    )
  }

  const stream = createCsvStream<ContactCsvRow>(
    [
      { header: 'id', value: row => row.id },
      { header: 'name', value: row => row.name },
      { header: 'email', value: row => row.email },
      { header: 'company', value: row => row.company ?? '' },
      { header: 'notes', value: row => row.notes ?? '' },
      { header: 'createdAt', value: row => row.createdAt },
      { header: 'updatedAt', value: row => row.updatedAt },
    ],
    (cursor, batchSize) =>
      prisma.contact.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: batchSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          name: true,
          email: true,
          company: true,
          notes: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
  )

  return new NextResponse(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="contacts.csv"',
    },
  })
}

export const GET = withRequestId(GETHandler)
