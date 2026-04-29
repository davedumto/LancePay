import { prisma } from '@/lib/db'
import { Decimal } from '@prisma/client/runtime/library'

export type DiscountType = 'percent' | 'flat'

export type DiscountInfo = {
  type: DiscountType
  value: number
  code?: string
  originalAmount: number
  appliedAmount: number
}

export async function applyDiscount(
  invoiceId: string,
  discount: { type: DiscountType; value: number; code?: string }
) {
  return await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
    })

    if (!invoice) throw new Error('Invoice not found')

    // Find if there's an existing original amount in audit logs
    const lastDiscount = await tx.auditEvent.findFirst({
      where: { invoiceId, eventType: 'invoice.discount_applied' },
      orderBy: { createdAt: 'desc' },
    })

    const originalAmount = lastDiscount 
      ? (lastDiscount.metadata as any).originalAmount 
      : Number(invoice.amount)

    let newAmount = originalAmount
    if (discount.type === 'percent') {
      if (discount.value < 0 || discount.value > 100) throw new Error('Invalid percent value')
      newAmount = originalAmount * (1 - discount.value / 100)
    } else {
      if (discount.value < 0 || discount.value > originalAmount) throw new Error('Invalid flat value')
      newAmount = originalAmount - discount.value
    }

    const updatedInvoice = await tx.invoice.update({
      where: { id: invoiceId },
      data: { amount: newAmount },
    })

    await tx.auditEvent.create({
      data: {
        invoiceId,
        eventType: 'invoice.discount_applied',
        metadata: {
          ...discount,
          originalAmount,
          appliedAmount: newAmount,
        } as any,
        signature: 'system-discount',
      },
    })

    return updatedInvoice
  })
}

export async function removeDiscount(invoiceId: string) {
  return await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
    })

    if (!invoice) throw new Error('Invoice not found')

    const lastDiscount = await tx.auditEvent.findFirst({
      where: { invoiceId, eventType: 'invoice.discount_applied' },
      orderBy: { createdAt: 'desc' },
    })

    if (!lastDiscount) return invoice

    const originalAmount = (lastDiscount.metadata as any).originalAmount

    const updatedInvoice = await tx.invoice.update({
      where: { id: invoiceId },
      data: { amount: originalAmount },
    })

    await tx.auditEvent.create({
      data: {
        invoiceId,
        eventType: 'invoice.discount_removed',
        metadata: {
          removedDiscount: lastDiscount.metadata,
        } as any,
        signature: 'system-discount',
      },
    })

    return updatedInvoice
  })
}
