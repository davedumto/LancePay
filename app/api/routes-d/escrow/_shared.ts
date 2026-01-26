import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function getAuthContext(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return { error: 'Unauthorized' as const }

  const claims = await verifyAuthToken(authToken)
  if (!claims) return { error: 'Invalid token' as const }

  let user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    const email = (claims as any).email || `${claims.userId}@privy.local`
    user = await prisma.user.create({ data: { privyId: claims.userId, email } })
  }

  const email = ((claims as any).email as string | undefined) || user.email
  return { user, claims, email }
}

export const EscrowEnableSchema = z.object({
  invoiceId: z.string().min(1),
  releaseConditions: z.string().max(5000).optional(),
})

export const EscrowReleaseSchema = z.object({
  invoiceId: z.string().min(1),
  clientEmail: z.string().email(),
  approvalNotes: z.string().max(5000).optional(),
})

export const EscrowDisputeSchema = z.object({
  invoiceId: z.string().min(1),
  clientEmail: z.string().email(),
  reason: z.string().min(5).max(5000),
  requestedAction: z.enum(['refund', 'revision']),
})

