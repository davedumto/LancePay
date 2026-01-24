import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export type DisputeParty = 'client' | 'freelancer'
export type DisputeSenderType = DisputeParty | 'admin'

export function parseAdminEmailsEnv(): string[] {
  const raw =
    process.env.ADMIN_EMAILS ||
    process.env.DISPUTE_ADMIN_EMAILS ||
    ''
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

export function isAdminEmail(email?: string | null): boolean {
  if (!email) return false
  const e = email.trim().toLowerCase()
  const admins = parseAdminEmailsEnv()
  return admins.includes(e)
}

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

export function senderTypeForDispute(params: {
  isAdmin: boolean
  isFreelancer: boolean
  isClient: boolean
}): DisputeSenderType | null {
  const { isAdmin, isFreelancer, isClient } = params
  if (isAdmin) return 'admin'
  if (isFreelancer) return 'freelancer'
  if (isClient) return 'client'
  return null
}

export const DisputeCreateSchema = z.object({
  invoiceId: z.string().min(1),
  initiatorEmail: z.string().email(),
  reason: z.string().min(5).max(5000),
  requestedAction: z.enum(['refund', 'partial_refund', 'revision']),
  evidence: z.array(z.string().url()).optional(),
})

export const DisputeRespondSchema = z.object({
  disputeId: z.string().min(1),
  senderEmail: z.string().email(),
  message: z.string().min(1).max(5000),
  attachments: z.array(z.string().url()).optional(),
})

export const DisputeResolveSchema = z.object({
  disputeId: z.string().min(1),
  resolution: z.string().min(3).max(10000),
  action: z.enum(['refund_full', 'refund_partial', 'no_refund']),
  refundAmount: z.number().positive().optional(),
  resolvedBy: z.enum(['admin', 'mutual_agreement']),
})

