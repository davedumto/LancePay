import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { BATCH_STATUS, ITEM_STATUS, resolvePayoutBatchActor } from './_lib/payout-batches'

const itemInputSchema = z.object({
  recipientIdentifier: z.string().trim().min(1, 'recipientIdentifier is required'),
  amount: z.union([z.string().trim(), z.number()]),
  payoutType: z.string().trim().default('stellar'),
})

const createBatchSchema = z.object({
  totalRecipients: z.number().int().positive('totalRecipients must be a positive integer'),
  totalAmount: z.union([z.string().trim(), z.number()]),
  scheduledAt: z.union([z.string().trim(), z.number(), z.date()]).optional().nullable(),
  items: z.array(itemInputSchema).min(1, 'items array must contain at least one recipient'),
})

/**
 * GET /api/payout-batches
 * Lists all payout batches for the authenticated user, newest first.
 * Supports optional ?status= query filter.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await resolvePayoutBatchActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    const status = request.nextUrl.searchParams.get('status')?.trim()

    const batches = await prisma.payoutBatch.findMany({
      where: {
        userId: actor.id,
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { items: true } },
      },
    })

    return NextResponse.json({ batches })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/payout-batches error')
    return NextResponse.json({ error: 'Failed to fetch payout batches' }, { status: 500 })
  }
}

/**
 * POST /api/payout-batches
 * Creates a new PayoutBatch with nested PayoutItem rows.
 * Validates totalRecipients, totalAmount sum, unique recipients, and optional scheduledAt.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await resolvePayoutBatchActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = createBatchSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }

    const { totalRecipients, totalAmount, scheduledAt, items } = parsed.data

    if (totalRecipients !== items.length) {
      return NextResponse.json(
        { error: `totalRecipients (${totalRecipients}) does not match the actual number of items (${items.length})` },
        { status: 400 },
      )
    }

    let parsedTotalAmount: Prisma.Decimal
    try {
      parsedTotalAmount = new Prisma.Decimal(totalAmount)
      if (parsedTotalAmount.lte(0)) {
        return NextResponse.json({ error: 'totalAmount must be greater than zero' }, { status: 400 })
      }
    } catch {
      return NextResponse.json({ error: 'totalAmount must be a valid numeric value' }, { status: 400 })
    }

    const seenRecipients = new Set<string>()
    let sumItemAmounts = new Prisma.Decimal(0)

    for (let i = 0; i < items.length; i++) {
      const item = items[i]

      if (seenRecipients.has(item.recipientIdentifier)) {
        return NextResponse.json(
          { error: `Duplicate recipientIdentifier found within the batch: ${item.recipientIdentifier}` },
          { status: 400 },
        )
      }
      seenRecipients.add(item.recipientIdentifier)

      let itemAmountDec: Prisma.Decimal
      try {
        itemAmountDec = new Prisma.Decimal(item.amount)
        if (itemAmountDec.lte(0)) {
          return NextResponse.json(
            { error: `Item amount at index ${i} must be greater than zero` },
            { status: 400 },
          )
        }
      } catch {
        return NextResponse.json(
          { error: `Item amount at index ${i} must be a valid numeric value` },
          { status: 400 },
        )
      }

      sumItemAmounts = sumItemAmounts.plus(itemAmountDec)
    }

    if (!parsedTotalAmount.equals(sumItemAmounts)) {
      return NextResponse.json(
        {
          error: `totalAmount (${parsedTotalAmount.toString()}) does not match the sum of item amounts (${sumItemAmounts.toString()})`,
        },
        { status: 400 },
      )
    }

    let scheduledAtDate: Date | null = null
    if (scheduledAt !== undefined && scheduledAt !== null) {
      const d = new Date(scheduledAt)
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: 'scheduledAt must be a valid date' }, { status: 400 })
      }
      scheduledAtDate = d
    }

    const batch = await prisma.payoutBatch.create({
      data: {
        userId: actor.id,
        status: BATCH_STATUS.pending,
        totalAmount: parsedTotalAmount,
        totalRecipients,
        scheduledAt: scheduledAtDate,
        items: {
          create: items.map((item) => ({
            recipientIdentifier: item.recipientIdentifier,
            amount: new Prisma.Decimal(item.amount),
            payoutType: item.payoutType || 'stellar',
            status: ITEM_STATUS.pending,
          })),
        },
      },
      include: {
        items: true,
      },
    })

    logger.info(
      { batchId: batch.id, userId: actor.id, totalRecipients, totalAmount: parsedTotalAmount.toString() },
      'Payout batch created',
    )

    return NextResponse.json({ batch }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/payout-batches error')
    return NextResponse.json({ error: 'Failed to create payout batch' }, { status: 500 })
  }
}
