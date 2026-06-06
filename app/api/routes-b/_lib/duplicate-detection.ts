import { prisma } from '@/lib/db'

const DUPLICATE_WINDOW_MS = 5 * 60 * 1000

type DuplicateLookupInput = {
  userId: string
  clientEmail: string
  amount: number
  currency: string
}

export async function findRecentDuplicateInvoice(input: DuplicateLookupInput) {
  const duplicate = await prisma.invoice.findFirst({
    where: {
      userId: input.userId,
      clientEmail: input.clientEmail,
      amount: input.amount,
      currency: input.currency,
      createdAt: {
        gte: new Date(Date.now() - DUPLICATE_WINDOW_MS),
      },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })

  return duplicate?.id ?? null
}

