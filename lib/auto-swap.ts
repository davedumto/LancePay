import { prisma } from '@/lib/db'
import { getUsdToNgnRate } from '@/lib/exchange-rate'
import { sendEmail } from '@/lib/email'
import { Decimal } from '@prisma/client/runtime/library'

/**
 * Result of an auto-swap execution attempt
 */
export interface AutoSwapResult {
  triggered: boolean
  swapAmount?: number
  remainingAmount?: number
  bankAccountId?: string
  bankAccountName?: string
  transactionId?: string
  error?: string
}

/**
 * Process auto-swap for a user when they receive a payment
 * 
 * @param userId - The user ID who received the payment
 * @param paymentAmount - The total USDC payment amount
 * @param userEmail - User's email for notification
 * @param freelancerName - User's name for notification
 * @returns AutoSwapResult indicating whether auto-swap was triggered and details
 */
export async function processAutoSwap(
  userId: string,
  paymentAmount: number,
  userEmail?: string,
  freelancerName?: string
): Promise<AutoSwapResult> {
  try {
    // Check if user has an active auto-swap rule
    const autoSwapRule = await prisma.autoSwapRule.findUnique({
      where: { userId },
      include: {
        bankAccount: {
          select: {
            id: true,
            bankName: true,
            accountNumber: true,
            accountName: true,
            isVerified: true,
          }
        }
      }
    })

    // No rule or rule is inactive
    if (!autoSwapRule || !autoSwapRule.isActive) {
      return { triggered: false }
    }

    // Validate bank account
    if (!autoSwapRule.bankAccount || !autoSwapRule.bankAccount.isVerified) {
      console.warn(`Auto-swap rule for user ${userId} has invalid/unverified bank account`)
      return { 
        triggered: false, 
        error: 'Bank account not verified' 
      }
    }

    // Calculate the swap amount
    const swapPercentage = autoSwapRule.percentage / 100
    const swapAmount = paymentAmount * swapPercentage
    const remainingAmount = paymentAmount - swapAmount

    // Get current exchange rate
    const rateResult = await getUsdToNgnRate()
    const exchangeRate = rateResult.rate
    const ngnAmount = swapAmount * exchangeRate

    // Create the auto-swap withdrawal transaction
    const withdrawalTransaction = await prisma.transaction.create({
      data: {
        userId,
        type: 'withdrawal',
        status: 'pending', // Will be updated by Yellow Card webhook
        amount: new Decimal(swapAmount),
        currency: 'USD',
        ngnAmount: new Decimal(ngnAmount),
        exchangeRate: new Decimal(exchangeRate),
        bankAccountId: autoSwapRule.bankAccountId,
        autoSwapTriggered: true,
      }
    })

    // TODO: Integrate with Yellow Card API to initiate the actual withdrawal
    // This would be the place to call the Yellow Card withdrawal API
    // For now, we'll mark it as processing and let the webhook update it
    await initiateYellowCardWithdrawal({
      transactionId: withdrawalTransaction.id,
      amount: ngnAmount,
      bankAccountId: autoSwapRule.bankAccountId,
      accountNumber: autoSwapRule.bankAccount.accountNumber,
      bankCode: autoSwapRule.bankAccount.bankName, // This should be the bank code in production
    })

    // Send notification email
    if (userEmail) {
      await sendAutoSwapNotification({
        to: userEmail,
        freelancerName: freelancerName || 'Freelancer',
        totalReceived: paymentAmount,
        swapAmount,
        remainingAmount,
        ngnAmount,
        bankName: autoSwapRule.bankAccount.bankName,
        accountNumber: autoSwapRule.bankAccount.accountNumber,
        percentage: autoSwapRule.percentage,
      })
    }

    return {
      triggered: true,
      swapAmount,
      remainingAmount,
      bankAccountId: autoSwapRule.bankAccountId,
      bankAccountName: autoSwapRule.bankAccount.accountName,
      transactionId: withdrawalTransaction.id,
    }
  } catch (error) {
    console.error('Auto-swap processing error:', error)
    return {
      triggered: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Initiate Yellow Card withdrawal
 * TODO: Implement actual Yellow Card API integration
 */
async function initiateYellowCardWithdrawal(params: {
  transactionId: string
  amount: number
  bankAccountId: string
  accountNumber: string
  bankCode: string
}): Promise<void> {
  // This is a placeholder for the Yellow Card API integration
  // In production, this would:
  // 1. Call Yellow Card's create withdrawal endpoint
  // 2. Store the Yellow Card transaction ID
  // 3. The webhook handler would then update the status
  
  console.log('Initiating Yellow Card withdrawal:', params)
  
  // For now, simulate successful initiation by updating status
  // In production, this would be done by the webhook
  await prisma.transaction.update({
    where: { id: params.transactionId },
    data: { status: 'processing' }
  })
}

/**
 * Send auto-swap notification email
 */
async function sendAutoSwapNotification(params: {
  to: string
  freelancerName: string
  totalReceived: number
  swapAmount: number
  remainingAmount: number
  ngnAmount: number
  bankName: string
  accountNumber: string
  percentage: number
}): Promise<void> {
  const maskedAccount = params.accountNumber.slice(-4).padStart(params.accountNumber.length, '*')
  
  try {
    await sendEmail({
      to: params.to,
      subject: `💸 Payment Received! $${params.totalReceived.toFixed(2)} - Auto-Swap Triggered`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #10B981;">Payment Received! 🎉</h2>
          
          <p>Hi ${params.freelancerName},</p>
          
          <p>Great news! You've just received a payment of <strong>$${params.totalReceived.toFixed(2)} USDC</strong>.</p>
          
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px; margin: 20px 0;">
            <h3 style="margin: 0 0 15px 0; color: white;">🔄 Auto-Swap Activated (${params.percentage}%)</h3>
            <p style="margin: 5px 0;"><strong>Converted:</strong> $${params.swapAmount.toFixed(2)} USDC → ₦${params.ngnAmount.toLocaleString()}</p>
            <p style="margin: 5px 0;"><strong>Sent to:</strong> ${params.bankName} (${maskedAccount})</p>
            <p style="margin: 5px 0;"><strong>Kept in Wallet:</strong> $${params.remainingAmount.toFixed(2)} USDC</p>
          </div>
          
          <p style="color: #6B7280; font-size: 14px;">
            Your auto-swap rule is working! The funds should arrive in your bank account within minutes.
          </p>
          
          <p style="color: #6B7280; font-size: 14px;">
            You can manage your auto-swap settings anytime from your dashboard.
          </p>
          
          <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 30px 0;" />
          
          <p style="color: #9CA3AF; font-size: 12px;">
            This is an automated notification from LancePay. If you didn't expect this, please contact support.
          </p>
        </div>
      `,
    })
  } catch (error) {
    console.error('Failed to send auto-swap notification:', error)
    // Don't throw - notification failure shouldn't stop the swap
  }
}
