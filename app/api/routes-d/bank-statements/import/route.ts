import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { z } from 'zod'
import { logger } from '@/lib/logger'

const TransactionImportSchema = z.object({
  externalId: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().min(3).max(3),
  type: z.string(),
  description: z.string().optional(),
})

const BodySchema = z.object({
  bankAccountId: z.string().uuid(),
  transactions: z.array(TransactionImportSchema).min(1),
})

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
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = BodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.format() },
        { status: 400 }
      )
    }

    const { bankAccountId, transactions } = parsed.data

    // Ownership and existence check
    const bankAccount = await prisma.bankAccount.findFirst({
      where: { id: bankAccountId, userId: user.id },
    })

    if (!bankAccount) {
      return NextResponse.json({ error: 'Bank account not found' }, { status: 404 })
    }

    let importedCount = 0
    let duplicatesCount = 0

    for (const tx of transactions) {
      const existing = await prisma.transaction.findUnique({
        where: { externalId: tx.externalId },
      })

      if (existing) {
        duplicatesCount++
        continue
      }

      await prisma.transaction.create({
        data: {
          userId: user.id,
          bankAccountId: bankAccount.id,
          externalId: tx.externalId,
          amount: tx.amount,
          currency: tx.currency,
          type: tx.type,
          status: 'completed',
          completedAt: new Date(),
          error: tx.description || null,
        },
      })
      importedCount++
    }

    return NextResponse.json({
      success: true,
      importedCount,
      duplicatesCount,
    })
  } catch (error) {
    logger.error({ err: error }, 'Bank statements import error')
    return NextResponse.json({ error: 'Failed to import bank statement' }, { status: 500 })
  }
}
