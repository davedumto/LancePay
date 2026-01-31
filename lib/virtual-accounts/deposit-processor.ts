/**
 * Deposit Processor
 * 
 * Handles the complete flow of processing virtual account deposits:
 * 1. Verify deposit hasn't been processed (idempotency)
 * 2. Get current NGN/USDC exchange rate
 * 3. Calculate USDC amount and fees
 * 4. Transfer USDC from funding wallet to user's Stellar wallet
 * 5. Record transaction
 * 6. Send notification email
 */

import { getUsdToNgnRate } from '../exchange-rate'
import { sendUSDCPayment } from '../stellar'
import { sendEmail } from '../email'
import {
  getFundingWallet,
  ensureSufficientBalance,
} from './funding-wallet'
import {
  createDepositTransaction,
  findExistingDeposit,
  completeDepositTransaction,
  failDepositTransaction,
} from './transaction-helper'
import { getVirtualAccountByAccountNumber } from './service'
import { validateMinimumDeposit } from './validation'
import { DepositWebhookPayload } from './provider-interface'
import { prisma } from '../db'

export interface DepositProcessingResult {
  success: boolean
  transactionId?: string
  userId?: string
  usdcCredited?: number
  ngnReceived?: number
  txHash?: string
  error?: string
  reason?: 'duplicate' | 'insufficient_minimum' | 'user_not_found' | 'wallet_not_found' | 'transfer_failed' | 'unknown'
}

/**
 * Platform fee configuration
 * This fee is deducted from the deposit before converting to USDC
 */
const PLATFORM_FEE_PERCENTAGE = parseFloat(
  process.env.PLATFORM_FEE_PERCENTAGE || '1.5'
) // Default: 1.5%

/**
 * Minimum deposit amount in NGN
 */
const MINIMUM_DEPOSIT_NGN = parseFloat(
  process.env.MINIMUM_DEPOSIT_NGN || '100'
) // Default: ₦100

/**
 * Process a virtual account deposit
 * This is the main entry point called by the webhook handler
 */
export async function processDeposit(
  payload: DepositWebhookPayload
): Promise<DepositProcessingResult> {
  try {
    console.log('Processing deposit:', {
      accountNumber: payload.accountNumber,
      amount: payload.amount,
      reference: payload.reference,
    })

    // Step 1: Idempotency check - has this deposit been processed already?
    const existingDeposit = await findExistingDeposit(payload.reference)
    if (existingDeposit) {
      console.log('Duplicate deposit detected:', payload.reference)
      return {
        success: true, // Return success to prevent webhook retries
        reason: 'duplicate',
        transactionId: existingDeposit.id,
        userId: existingDeposit.userId,
      }
    }

    // Step 2: Validate minimum deposit
    const minCheck = validateMinimumDeposit(payload.amount, MINIMUM_DEPOSIT_NGN)
    if (!minCheck.valid) {
      console.log('Deposit below minimum:', minCheck.error)
      return {
        success: false,
        reason: 'insufficient_minimum',
        error: minCheck.error,
      }
    }

    // Step 3: Find virtual account and user
    const virtualAccount = await getVirtualAccountByAccountNumber(
      payload.accountNumber
    )

    if (!virtualAccount) {
      console.error('Virtual account not found:', payload.accountNumber)
      return {
        success: false,
        reason: 'user_not_found',
        error: 'Virtual account not found',
      }
    }

    // Step 4: Fetch user's Stellar wallet
    const user = await prisma.user.findUnique({
      where: { id: virtualAccount.userId },
      include: { wallet: true },
    })

    if (!user || !user.wallet) {
      console.error('User wallet not found for user:', virtualAccount.userId)
      return {
        success: false,
        reason: 'wallet_not_found',
        error: 'User wallet not configured',
      }
    }

    // Step 5: Get current exchange rate
    const rateResult = await getUsdToNgnRate()
    const exchangeRate = rateResult.rate

    // Step 6: Calculate amounts
    const ngnAmount = payload.amount
    const platformFee = ngnAmount * (PLATFORM_FEE_PERCENTAGE / 100)
    const ngnAfterFee = ngnAmount - platformFee
    const usdcAmount = ngnAfterFee / exchangeRate

    // Round USDC to 2 decimal places
    const usdcAmountRounded = Math.floor(usdcAmount * 100) / 100

    console.log('Deposit calculation:', {
      ngnAmount,
      platformFee,
      ngnAfterFee,
      exchangeRate,
      usdcAmount: usdcAmountRounded,
    })

    // Step 7: Create pending transaction record
    const { id: transactionId } = await createDepositTransaction({
      userId: user.id,
      virtualAccountId: virtualAccount.id,
      ngnAmount,
      usdcAmount: usdcAmountRounded,
      exchangeRate,
      providerReference: payload.reference,
      senderName: payload.senderName,
      narration: payload.narration,
    })

    // Step 8: Ensure funding wallet has sufficient balance
    try {
      await ensureSufficientBalance(usdcAmountRounded)
    } catch (balanceError) {
      // Mark transaction as failed
      await failDepositTransaction(
        transactionId,
        `Insufficient USDC in funding wallet: ${balanceError instanceof Error ? balanceError.message : 'Unknown'}`
      )

      console.error('Funding wallet insufficient balance:', balanceError)
      return {
        success: false,
        transactionId,
        userId: user.id,
        reason: 'transfer_failed',
        error: 'Insufficient platform liquidity. Please contact support.',
      }
    }

    // Step 9: Transfer USDC from funding wallet to user's Stellar wallet
    const fundingWallet = getFundingWallet()

    let txHash: string
    try {
      txHash = await sendUSDCPayment(
        fundingWallet.publicKey,
        fundingWallet.secretKey,
        user.wallet.address,
        usdcAmountRounded.toString()
      )

      console.log('USDC transfer successful:', {
        from: fundingWallet.publicKey,
        to: user.wallet.address,
        amount: usdcAmountRounded,
        txHash,
      })
    } catch (transferError) {
      // Mark transaction as failed
      await failDepositTransaction(
        transactionId,
        `Stellar transfer failed: ${transferError instanceof Error ? transferError.message : 'Unknown'}`
      )

      console.error('Stellar USDC transfer failed:', transferError)
      return {
        success: false,
        transactionId,
        userId: user.id,
        reason: 'transfer_failed',
        error: 'USDC transfer failed. Funds are safe, please contact support.',
      }
    }

    // Step 10: Update transaction as completed
    await completeDepositTransaction(transactionId, txHash)

    // Step 11: Send notification email
    if (user.email) {
      try {
        await sendDepositNotificationEmail({
          to: user.email,
          userName: user.name || 'User',
          ngnAmount,
          usdcAmount: usdcAmountRounded,
          exchangeRate,
          platformFee,
          senderName: payload.senderName,
          reference: payload.reference,
        })
      } catch (emailError) {
        // Don't fail the deposit if email fails
        console.error('Failed to send deposit notification email:', emailError)
      }
    }

    console.log('Deposit processed successfully:', {
      transactionId,
      userId: user.id,
      ngnAmount,
      usdcAmount: usdcAmountRounded,
      txHash,
    })

    return {
      success: true,
      transactionId,
      userId: user.id,
      usdcCredited: usdcAmountRounded,
      ngnReceived: ngnAmount,
      txHash,
    }
  } catch (error) {
    console.error('Deposit processing error:', error)
    return {
      success: false,
      reason: 'unknown',
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Send deposit notification email to user
 */
async function sendDepositNotificationEmail(params: {
  to: string
  userName: string
  ngnAmount: number
  usdcAmount: number
  exchangeRate: number
  platformFee: number
  senderName?: string
  reference: string
}): Promise<void> {
  const feePercentage = PLATFORM_FEE_PERCENTAGE.toFixed(2)

  await sendEmail({
    to: params.to,
    subject: `💰 Deposit Received - ₦${params.ngnAmount.toLocaleString()} → $${params.usdcAmount.toFixed(2)} USDC`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #10B981;">Deposit Received! 💰</h2>
        
        <p>Hi ${params.userName},</p>
        
        <p>Great news! A deposit to your LancePay virtual account has been processed successfully.</p>
        
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px; margin: 20px 0;">
          <h3 style="margin: 0 0 15px 0; color: white;">Deposit Summary</h3>
          <p style="margin: 5px 0;"><strong>NGN Received:</strong> ₦${params.ngnAmount.toLocaleString()}</p>
          <p style="margin: 5px 0;"><strong>Platform Fee (${feePercentage}%):</strong> ₦${params.platformFee.toFixed(2)}</p>
          <p style="margin: 5px 0;"><strong>Exchange Rate:</strong> ₦${params.exchangeRate.toFixed(2)}/USD</p>
          <p style="margin: 5px 0; font-size: 18px;"><strong>USDC Credited:</strong> $${params.usdcAmount.toFixed(2)} USDC</p>
        </div>
        
        ${params.senderName ? `<p><strong>From:</strong> ${params.senderName}</p>` : ''}
        <p><strong>Reference:</strong> ${params.reference}</p>
        
        <p style="color: #6B7280; font-size: 14px;">
          Your USDC is now available in your LancePay wallet and can be withdrawn to your bank account anytime.
        </p>
        
        <p style="color: #6B7280; font-size: 14px;">
          Thank you for using LancePay!
        </p>
      </div>
    `,
  })
}