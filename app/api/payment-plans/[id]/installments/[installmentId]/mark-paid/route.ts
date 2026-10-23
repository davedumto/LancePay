import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; installmentId: string }> },
) {
  try {
    const { id, installmentId } = await params
    const token = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(token)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const plan = await prisma.paymentPlan.findFirst({
      where: { id, userId: user.id },
      select: { id: true, invoiceId: true, status: true },
    })
    if (!plan) return NextResponse.json({ error: 'Payment plan not found' }, { status: 404 })
    if (plan.status !== 'active') {
      return NextResponse.json({ error: `Payment plan in status '${plan.status}' cannot be paid` }, { status: 409 })
    }

    const installment = await prisma.paymentPlanInstallment.findFirst({
      where: { id: installmentId, paymentPlanId: id },
      select: { id: true, status: true },
    })
    if (!installment) return NextResponse.json({ error: 'Installment not found' }, { status: 404 })
    if (installment.status === 'paid') {
      return NextResponse.json({ error: 'Installment is already paid' }, { status: 409 })
    }
    if (installment.status !== 'pending') {
      return NextResponse.json({ error: `Installment in status '${installment.status}' cannot be paid` }, { status: 409 })
    }

    const paidAt = new Date()
    const result = await prisma.$transaction(async (tx) => {
      const marked = await tx.paymentPlanInstallment.updateMany({
        where: { id: installmentId, paymentPlanId: id, status: 'pending' },
        data: { status: 'paid', paidAt },
      })
      if (marked.count !== 1) return null

      const remaining = await tx.paymentPlanInstallment.count({
        where: { paymentPlanId: id, status: { not: 'paid' } },
      })
      if (remaining > 0) return { completed: false }

      const completed = await tx.paymentPlan.updateMany({
        where: { id, userId: user.id, status: 'active' },
        data: { status: 'completed' },
      })
      if (completed.count !== 1) return null

      await tx.invoice.updateMany({
        where: { id: plan.invoiceId, userId: user.id, status: { not: 'paid' } },
        data: { status: 'paid', paidAt },
      })
      return { completed: true }
    }, { isolationLevel: 'Serializable' })

    if (!result) return NextResponse.json({ error: 'Installment could not be marked as paid' }, { status: 409 })
    return NextResponse.json({
      installment: { id: installmentId, status: 'paid', paidAt: paidAt.toISOString() },
      paymentPlan: { id, status: result.completed ? 'completed' : 'active' },
    })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/payment-plans/[id]/installments/[installmentId]/mark-paid error')
    return NextResponse.json({ error: 'Failed to mark installment as paid' }, { status: 500 })
  }
}