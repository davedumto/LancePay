import { prisma } from '@/lib/db'

interface ProcessSavingsResult {
  processed: boolean
  totalSaved: number
  mainBalance: number
  goalUpdates: Array<{
    goalId: string
    title: string
    amountAdded: number
    newTotal: number
    completed: boolean
  }>
}

export async function processSavingsOnPayment(
  userId: string,
  invoiceAmountUsdc: number
): Promise<ProcessSavingsResult> {
  const activeGoals = await prisma.savingsGoal.findMany({
    where: { userId, isActive: true, status: 'in_progress' },
  })

  if (activeGoals.length === 0) {
    return {
      processed: false,
      totalSaved: 0,
      mainBalance: invoiceAmountUsdc,
      goalUpdates: [],
    }
  }

  let totalSaved = 0
  const goalUpdates: ProcessSavingsResult['goalUpdates'] = []

  for (const goal of activeGoals) {
    const deductionAmount = (invoiceAmountUsdc * goal.savingsPercentage) / 100
    const currentAmount = Number(goal.currentAmountUsdc)
    const targetAmount = Number(goal.targetAmountUsdc)
    const newAmount = currentAmount + deductionAmount
    const isCompleted = newAmount >= targetAmount

    await prisma.savingsGoal.update({
      where: { id: goal.id },
      data: {
        currentAmountUsdc: newAmount,
        status: isCompleted ? 'completed' : 'in_progress',
        isActive: isCompleted ? false : goal.isActive,
      },
    })

    totalSaved += deductionAmount
    goalUpdates.push({
      goalId: goal.id,
      title: goal.title,
      amountAdded: deductionAmount,
      newTotal: newAmount,
      completed: isCompleted,
    })
  }

  return {
    processed: true,
    totalSaved,
    mainBalance: invoiceAmountUsdc - totalSaved,
    goalUpdates,
  }
}
