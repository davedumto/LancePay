import { prisma } from '@/lib/db'
import { randomUUID } from 'crypto'

interface WaterfallResult {
  processed: boolean
  leadShare: number
  distributions: Array<{
    subContractorId: string
    email: string
    walletAddress: string
    sharePercentage: number
    amount: number
    status: 'completed' | 'failed'
    internalTxId?: string
    error?: string
  }>
}

export async function validateCollaboratorPercentages(
  invoiceId: string,
  newPercentage: number,
  excludeCollaboratorId?: string
): Promise<{ valid: boolean; totalPercentage: number; error?: string }> {
  const existingCollaborators = await prisma.invoiceCollaborator.findMany({
    where: {
      invoiceId,
      ...(excludeCollaboratorId ? { id: { not: excludeCollaboratorId } } : {}),
    },
  })

  const currentTotal = existingCollaborators.reduce(
    (sum, c) => sum + Number(c.sharePercentage),
    0
  )
  const newTotal = currentTotal + newPercentage

  if (newTotal > 100) {
    return {
      valid: false,
      totalPercentage: newTotal,
      error: `Total percentage would be ${newTotal}%, which exceeds 100%`,
    }
  }

  return { valid: true, totalPercentage: newTotal }
}

export async function processWaterfallPayments(
  invoiceId: string,
  invoiceAmount: number,
  source: 'payment' | 'escrow' = 'payment',
  tx?: any
): Promise<WaterfallResult> {
  const db = tx ?? prisma

  const collaborators = await db.invoiceCollaborator.findMany({
    where: { invoiceId, payoutStatus: 'pending' },
    include: {
      subContractor: {
        select: {
          id: true,
          email: true,
          wallet: { select: { address: true } },
        },
      },
    },
  })

  if (collaborators.length === 0) {
    return {
      processed: false,
      leadShare: invoiceAmount,
      distributions: [],
    }
  }

  const distributions: WaterfallResult['distributions'] = []
  let totalDistributed = 0

  for (const collaborator of collaborators) {
    const shareAmount = (invoiceAmount * Number(collaborator.sharePercentage)) / 100
    const internalTxId = `wtf_${randomUUID()}`

    try {
      // In production, this would trigger actual USDC transfer
      // For now, we record the internal transaction
      await db.invoiceCollaborator.update({
        where: { id: collaborator.id },
        data: {
          payoutStatus: 'completed',
          internalTxId,
          paymentSource: source,
          paidAt: new Date(),
        },
      })

      totalDistributed += shareAmount
      distributions.push({
        subContractorId: collaborator.subContractorId,
        email: collaborator.subContractor.email,
        walletAddress: collaborator.subContractor.wallet?.address || '',
        sharePercentage: Number(collaborator.sharePercentage),
        amount: shareAmount,
        status: 'completed',
        internalTxId,
      })
    } catch (error) {
      // On failure, update payoutStatus but do not rethrow
      await db.invoiceCollaborator.update({
        where: { id: collaborator.id },
        data: { payoutStatus: 'failed' },
      })

      distributions.push({
        subContractorId: collaborator.subContractorId,
        email: collaborator.subContractor.email,
        walletAddress: collaborator.subContractor.wallet?.address || '',
        sharePercentage: Number(collaborator.sharePercentage),
        amount: shareAmount,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  return {
    processed: true,
    leadShare: invoiceAmount - totalDistributed,
    distributions,
  }
}

export async function getInvoiceCollaborators(invoiceId: string) {
  return prisma.invoiceCollaborator.findMany({
    where: { invoiceId },
    include: {
      subContractor: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })
}

export async function addCollaborator(
  invoiceId: string,
  subContractorEmail: string,
  sharePercentage: number
) {
  // Find the sub-contractor by email
  const subContractor = await prisma.user.findUnique({
    where: { email: subContractorEmail },
  })

  if (!subContractor) {
    throw new Error('Sub-contractor not found with this email')
  }

  // Get invoice to verify ownership
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { dispute: true },
  })

  if (!invoice) {
    throw new Error('Invoice not found')
  }

  // Check if invoice has active dispute
  if (invoice.dispute && invoice.dispute.status === 'open') {
    throw new Error('Cannot modify collaborators while invoice has an open dispute')
  }

  // Prevent adding invoice owner as collaborator
  if (subContractor.id === invoice.userId) {
    throw new Error('Cannot add invoice owner as a collaborator')
  }

  // Validate percentages
  const validation = await validateCollaboratorPercentages(invoiceId, sharePercentage)
  if (!validation.valid) {
    throw new Error(validation.error)
  }

  return prisma.invoiceCollaborator.create({
    data: {
      invoiceId,
      subContractorId: subContractor.id,
      sharePercentage,
    },
    include: {
      subContractor: {
        select: { id: true, email: true, name: true },
      },
    },
  })
}

export async function removeCollaborator(collaboratorId: string, userId: string) {
  const collaborator = await prisma.invoiceCollaborator.findUnique({
    where: { id: collaboratorId },
    include: { invoice: true },
  })

  if (!collaborator) {
    throw new Error('Collaborator not found')
  }

  if (collaborator.invoice.userId !== userId) {
    throw new Error('Not authorized to remove this collaborator')
  }

  if (collaborator.payoutStatus === 'completed') {
    throw new Error('Cannot remove a collaborator who has already been paid')
  }

  return prisma.invoiceCollaborator.delete({
    where: { id: collaboratorId },
  })
}

export async function updateCollaboratorShare(
  collaboratorId: string,
  userId: string,
  newPercentage: number
) {
  const collaborator = await prisma.invoiceCollaborator.findUnique({
    where: { id: collaboratorId },
    include: { invoice: true },
  })

  if (!collaborator) {
    throw new Error('Collaborator not found')
  }

  if (collaborator.invoice.userId !== userId) {
    throw new Error('Not authorized to update this collaborator')
  }

  if (collaborator.payoutStatus === 'completed') {
    throw new Error('Cannot update share for a collaborator who has already been paid')
  }

  // Validate new percentage
  const validation = await validateCollaboratorPercentages(
    collaborator.invoiceId,
    newPercentage,
    collaboratorId
  )
  if (!validation.valid) {
    throw new Error(validation.error)
  }

  return prisma.invoiceCollaborator.update({
    where: { id: collaboratorId },
    data: { sharePercentage: newPercentage },
    include: {
      subContractor: {
        select: { id: true, email: true, name: true },
      },
    },
  })
}
