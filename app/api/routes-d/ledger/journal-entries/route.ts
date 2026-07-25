import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const MAX_MEMO_LENGTH = 500
const MAX_ACCOUNT_LENGTH = 100
const BALANCE_TOLERANCE = 0.005

async function authenticate(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return { error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) }
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
  if (!user) {
    return { error: NextResponse.json({ error: 'User not found' }, { status: 401 }) }
  }

  return { user }
}

const entrySelect = {
  id: true,
  entryDate: true,
  memo: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  lines: {
    select: {
      id: true,
      account: true,
      debit: true,
      credit: true,
    },
  },
} as const

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if (auth.error) return auth.error

    const limitParam = request.nextUrl.searchParams.get('limit')
    let limit = DEFAULT_LIMIT
    if (limitParam !== null) {
      limit = Number(limitParam)
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        return NextResponse.json(
          { error: `limit must be an integer between 1 and ${MAX_LIMIT}` },
          { status: 400 },
        )
      }
    }

    const entries = await prisma.journalEntry.findMany({
      where: { userId: auth.user.id },
      orderBy: { entryDate: 'desc' },
      take: limit,
      select: entrySelect,
    })

    return NextResponse.json({ entries })
  } catch (error) {
    logger.error({ err: error }, 'GET /ledger/journal-entries error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

type JournalLineInput = { account?: unknown; debit?: unknown; credit?: unknown }

function validateLine(line: JournalLineInput, index: number): string | null {
  if (typeof line.account !== 'string' || line.account.trim() === '') {
    return `lines[${index}].account must be a non-empty string`
  }
  if (line.account.trim().length > MAX_ACCOUNT_LENGTH) {
    return `lines[${index}].account must be at most ${MAX_ACCOUNT_LENGTH} characters`
  }

  const debit = line.debit ?? 0
  const credit = line.credit ?? 0
  if (typeof debit !== 'number' || !Number.isFinite(debit) || debit < 0) {
    return `lines[${index}].debit must be a non-negative number`
  }
  if (typeof credit !== 'number' || !Number.isFinite(credit) || credit < 0) {
    return `lines[${index}].credit must be a non-negative number`
  }
  if (debit > 0 && credit > 0) {
    return `lines[${index}] cannot have both a debit and a credit amount`
  }
  if (debit === 0 && credit === 0) {
    return `lines[${index}] must have a debit or a credit amount`
  }
  return null
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if (auth.error) return auth.error

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { entryDate, memo, lines } = (body ?? {}) as {
      entryDate?: unknown
      memo?: unknown
      lines?: unknown
    }

    let parsedDate: Date | undefined
    if (entryDate !== undefined) {
      if (typeof entryDate !== 'string' || Number.isNaN(Date.parse(entryDate))) {
        return NextResponse.json(
          { error: 'entryDate must be a valid ISO 8601 date string' },
          { status: 400 },
        )
      }
      parsedDate = new Date(entryDate)
    }

    if (memo !== undefined && typeof memo !== 'string') {
      return NextResponse.json({ error: 'memo must be a string' }, { status: 400 })
    }
    if (typeof memo === 'string' && memo.length > MAX_MEMO_LENGTH) {
      return NextResponse.json(
        { error: `memo must be at most ${MAX_MEMO_LENGTH} characters` },
        { status: 400 },
      )
    }

    if (!Array.isArray(lines) || lines.length < 2) {
      return NextResponse.json(
        { error: 'lines must be an array of at least two entries' },
        { status: 400 },
      )
    }

    for (let i = 0; i < lines.length; i += 1) {
      const validationError = validateLine(lines[i] as JournalLineInput, i)
      if (validationError) {
        return NextResponse.json({ error: validationError }, { status: 400 })
      }
    }

    const typedLines = lines as Array<{ account: string; debit?: number; credit?: number }>
    const totalDebit = typedLines.reduce((sum, line) => sum + (line.debit ?? 0), 0)
    const totalCredit = typedLines.reduce((sum, line) => sum + (line.credit ?? 0), 0)
    if (Math.abs(totalDebit - totalCredit) > BALANCE_TOLERANCE) {
      return NextResponse.json(
        { error: 'total debits must equal total credits' },
        { status: 400 },
      )
    }

    const entry = await prisma.journalEntry.create({
      data: {
        userId: auth.user.id,
        ...(parsedDate && { entryDate: parsedDate }),
        memo: typeof memo === 'string' && memo.trim() !== '' ? memo.trim() : null,
        lines: {
          create: typedLines.map((line) => ({
            account: line.account.trim(),
            debit: line.debit ?? 0,
            credit: line.credit ?? 0,
          })),
        },
      },
      select: entrySelect,
    })

    return NextResponse.json({ entry }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /ledger/journal-entries error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
