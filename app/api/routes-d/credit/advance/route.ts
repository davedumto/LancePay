import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import {
  checkAdvanceEligibility,
  ELIGIBILITY_CRITERIA,
} from '@/lib/advance-eligibility'
import { getUsdToNgnRate } from '@/lib/exchange-rate'
import { initiateYellowCardWithdrawal } from '@/lib/yellow-card'
import { sendEmail } from '@/lib/email'
import { Decimal } from '@prisma/client/runtime/library'

const AdvanceRequestSchema = z.object({
  invoiceId: z.string().uuid('Invalid invoice ID'),
  requestedAmountUSDC: z
    .number()
    .positive('Amount must be positive')
    .max(50000, 'Amount too large'),
})

/**
 * POST /api/routes-d/credit/advance
 * Request a payment advance on a pending invoice
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const authToken = request.headers
      .get('authorization')
      ?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      include: {
        bankAccounts: {
          where: { isDefault: true, isVerified: true },
          take: 1,
        },
      },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Validate request
    const body = await request.json()
    const validation = AdvanceRequestSchema.safeParse(body)

    if (!validation.success) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          details: validation.error.flatten().fieldErrors,
        },
        { status: 400 }
      )
    }

    const { invoiceId, requestedAmountUSDC } = validation.data

    // Check eligibility
    const eligibility = await checkAdvanceEligibility(
      user.id,
      invoiceId,
      requestedAmountUSDC
    )

    if (!eligibility.eligible) {
      return NextResponse.json(
        {
          error: 'Not eligible for advance',
          reason: eligibility.reason,
          maxAdvanceAmount: eligibility.maxAdvanceAmount,
        },
        { status: 403 }
      )
    }

    // Get exchange rate
    const rateResult = await getUsdToNgnRate()
    const exchangeRate = rateResult.rate

    // Calculate amounts
    const feePercentage = ELIGIBILITY_CRITERIA.ADVANCE_FEE_PERCENTAGE
    const feeAmount = requestedAmountUSDC * feePercentage
    const totalRepayment = requestedAmountUSDC + feeAmount
    const ngnAmount = requestedAmountUSDC * exchangeRate

    // Get default bank account
    const bankAccount = user.bankAccounts[0]
    if (!bankAccount) {
      return NextResponse.json(
        { error: 'No verified bank account found' },
        { status: 400 }
      )
    }

    // Create advance record in transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create payment advance record
      const advance = await tx.paymentAdvance.create({
        data: {
          userId: user.id,
          invoiceId,
          requestedAmountUSDC: new Decimal(requestedAmountUSDC),
          advancedAmountUSDC: new Decimal(requestedAmountUSDC),
          advancedAmountNGN: new Decimal(ngnAmount),
          exchangeRate: new Decimal(exchangeRate),
          feePercentage: new Decimal(feePercentage * 100), // Store as percentage
          feeAmountUSDC: new Decimal(feeAmount),
          totalRepaymentUSDC: new Decimal(totalRepayment),
          status: 'pending',
        },
      })

      // Set lien on invoice
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          lienActive: true,
        },
      })

      return advance
    })

    // Initiate Yellow Card withdrawal
    const withdrawal = await initiateYellowCardWithdrawal({
      amount: ngnAmount,
      bankAccountId: bankAccount.id,
      accountNumber: bankAccount.accountNumber,
      bankCode: bankAccount.bankCode,
      recipientName: bankAccount.accountName,
      recipientEmail: user.email,
      reference: result.id,
    })

    // Update advance with Yellow Card transaction ID
    if (withdrawal.success && withdrawal.transactionId) {
      await prisma.paymentAdvance.update({
        where: { id: result.id },
        data: {
          status: 'disbursed',
          yellowCardTransactionId: withdrawal.transactionId,
          disbursedAt: new Date(),
        },
      })

      // Send success email
      await sendAdvanceConfirmationEmail({
        to: user.email,
        userName: user.name || 'User',
        advancedAmount: requestedAmountUSDC,
        ngnAmount,
        feeAmount,
        totalRepayment,
        bankName: bankAccount.bankName,
        accountNumber: bankAccount.accountNumber,
      })

      return NextResponse.json(
        {
          success: true,
          message: 'Payment advance initiated successfully',
          advance: {
            id: result.id,
            amount: requestedAmountUSDC,
            ngnAmount,
            feeAmount,
            totalRepayment,
            status: 'disbursed',
            exchangeRate,
          },
        },
        { status: 201 }
      )
    } else {
      // Yellow Card failed - mark as failed and release lien
      await prisma.$transaction([
        prisma.paymentAdvance.update({
          where: { id: result.id },
          data: {
            status: 'failed',
            error: withdrawal.error,
          },
        }),
        prisma.invoice.update({
          where: { id: invoiceId },
          data: { lienActive: false },
        }),
      ])

      return NextResponse.json(
        {
          error: 'Failed to disburse advance',
          details: withdrawal.error,
        },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error('Payment advance error:', error)
    return NextResponse.json(
      { error: 'Failed to process advance request' },
      { status: 500 }
    )
  }
}

/**
 * Send advance confirmation email
 */
async function sendAdvanceConfirmationEmail(params: {
  to: string
  userName: string
  advancedAmount: number
  ngnAmount: number
  feeAmount: number
  totalRepayment: number
  bankName: string
  accountNumber: string
}) {
  const maskedAccount = params.accountNumber
    .slice(-4)
    .padStart(params.accountNumber.length, '*')

  try {
    await sendEmail({
      to: params.to,
      subject: `Payment Advance Approved - ₦${params.ngnAmount.toLocaleString()} on the way!`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #10B981;">Payment Advance Approved! 💰</h2>

          <p>Hi ${params.userName},</p>

          <p>Great news! Your payment advance request has been approved and is being processed.</p>

          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px; margin: 20px 0;">
            <h3 style="margin: 0 0 15px 0; color: white;">Advance Details</h3>
            <p style="margin: 5px 0;"><strong>Advance Amount:</strong> $${params.advancedAmount.toFixed(2)} USDC</p>
            <p style="margin: 5px 0;"><strong>NGN Amount:</strong> ₦${params.ngnAmount.toLocaleString()}</p>
            <p style="margin: 5px 0;"><strong>Fee (2%):</strong> $${params.feeAmount.toFixed(2)} USDC</p>
            <p style="margin: 5px 0;"><strong>Total Repayment:</strong> $${params.totalRepayment.toFixed(2)} USDC</p>
            <p style="margin: 5px 0;"><strong>Bank:</strong> ${params.bankName} (${maskedAccount})</p>
          </div>

          <div style="background: #FEF3C7; border-left: 4px solid #F59E0B; padding: 15px; margin: 20px 0;">
            <p style="margin: 0; color: #92400E;"><strong>Important:</strong> The advance + 2% fee will be automatically deducted when your invoice is paid.</p>
          </div>

          <p style="color: #6B7280; font-size: 14px;">
            The funds should arrive in your bank account within minutes to a few hours.
          </p>

          <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 30px 0;" />

          <p style="color: #9CA3AF; font-size: 12px;">
            This is an automated notification from LancePay Credit Services.
          </p>
        </div>
      `,
    })
  } catch (error) {
    console.error('Failed to send advance confirmation email:', error)
  }
}
