import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyAuthToken } from '@/lib/auth';
import { getAccountBalance, isValidStellarAddress, sendUSDCPayment } from '@/lib/stellar';
import { initiateWithdrawal } from '../../yello-card';

interface MassPayoutItem {
  amount: string;
  recipient: string;
  type: 'USDC' | 'BANK';
  bankCode?: string;
}

interface MassPayoutRequest {
  items: MassPayoutItem[];
}

// Helper function to validate NUBAN (Nigerian bank account number)
function isValidNUBAN(accountNumber: string): boolean {
  // NUBAN should be exactly 10 digits
  return /^\d{10}$/.test(accountNumber);
}

// Helper function to validate bank code
function isValidBankCode(bankCode: string): boolean {
  // Bank codes in Nigeria are typically 3 digits
  return /^\d{3}$/.test(bankCode);
}

// Platform fee rate (0.5%) applied on every payout
const PLATFORM_FEE_RATE = 0.005;

// Flat Yellow Card bank transfer fee per BANK item (USDC equivalent)
const BANK_TRANSFER_FEE_USDC = 0.3;

// Calculate total estimated fees accounting for platform fees and bank transfer fees
function calculateEstimatedFees(items: MassPayoutItem[]): number {
  let total = 0;

  for (const item of items) {
    const amount = parseFloat(item.amount);

    // Platform fee (0.5%) on every payout
    const platformFee = amount * PLATFORM_FEE_RATE;

    // Stellar gas fee per transaction (conservative USDC estimate)
    const gasFeeUSDC = 0.1;

    if (item.type === 'BANK') {
      // BANK payouts incur Yellow Card withdrawal fee on top
      total += platformFee + gasFeeUSDC + BANK_TRANSFER_FEE_USDC;
    } else {
      total += platformFee + gasFeeUSDC;
    }
  }

  return parseFloat(total.toFixed(7));
}

async function processPayoutItem(
  item: MassPayoutItem,
  userId: string,
  userWallet: any,
  batchId: string
): Promise<{ success: boolean; txHash?: string; errorMessage?: string }> {
  try {
    if (item.type === 'USDC') {
      // Validate Stellar address
      if (!isValidStellarAddress(item.recipient)) {
        return { success: false, errorMessage: 'Invalid Stellar wallet address' };
      }

      // Process Stellar USDC payment
      const txHash = await sendUSDCPayment(
        userWallet.address,
        process.env.STELLAR_SECRET_KEY!,
        item.recipient,
        item.amount
      );

      return { success: true, txHash };
    } else if (item.type === 'BANK') {
      // Validate bank details
      if (!isValidNUBAN(item.recipient)) {
        return { success: false, errorMessage: 'Invalid NUBAN (bank account number)' };
      }

      if (!item.bankCode || !isValidBankCode(item.bankCode)) {
        return { success: false, errorMessage: 'Invalid or missing bank code' };
      }

      // Find user's bank account that matches the provided details
      const bankAccount = await prisma.bankAccount.findFirst({
        where: {
          userId,
          accountNumber: item.recipient,
          bankCode: item.bankCode,
          isVerified: true
        }
      });

      if (!bankAccount) {
        return { success: false, errorMessage: 'Bank account not found or not verified' };
      }

      // Process Yellow Card withdrawal
      const withdrawalResult = await initiateWithdrawal({
        amount: parseFloat(item.amount),
        bankAccountId: bankAccount.id,
        userId
      });

      return { success: true, txHash: withdrawalResult.id };
    } else {
      return { success: false, errorMessage: 'Invalid payout type' };
    }
  } catch (error: any) {
    console.error('Error processing payout item:', error);
    const errorMessage = error?.message || 'Unknown error occurred';

    return { success: false, errorMessage };
  }
}

export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '');
    if (!authToken) {
      return NextResponse.json(
        { error: 'Unauthorized: No auth token provided' },
        { status: 401 }
      );
    }

    const claims = await verifyAuthToken(authToken);
    if (!claims) {
      return NextResponse.json(
        { error: 'Unauthorized: Invalid token' },
        { status: 401 }
      );
    }

    // Get or create user
    let user = await prisma.user.findUnique({ where: { privyId: claims.userId } });
    if (!user) {
      const email = (claims as { email?: string }).email || `${claims.userId}@privy.local`;
      user = await prisma.user.create({ data: { privyId: claims.userId, email } });
    }

    const userId = user.id;
    const body: MassPayoutRequest = await request.json();

    // Validate request body
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      return NextResponse.json(
        { error: 'Invalid request: items array is required and must not be empty' },
        { status: 400 }
      );
    }

    if (body.items.length > 100) {
      return NextResponse.json(
        { error: 'Too many items: maximum 100 items per batch' },
        { status: 400 }
      );
    }

    // Validate each item
    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i];

      if (!item.amount || !item.recipient || !item.type) {
        return NextResponse.json(
          { error: `Invalid item at index ${i}: amount, recipient, and type are required` },
          { status: 400 }
        );
      }

      if (isNaN(parseFloat(item.amount)) || parseFloat(item.amount) <= 0) {
        return NextResponse.json(
          { error: `Invalid amount at index ${i}: must be a positive number` },
          { status: 400 }
        );
      }

      if (!['USDC', 'BANK'].includes(item.type)) {
        return NextResponse.json(
          { error: `Invalid type at index ${i}: must be 'USDC' or 'BANK'` },
          { status: 400 }
        );
      }

      if (item.type === 'BANK' && !item.bankCode) {
        return NextResponse.json(
          { error: `Bank type at index ${i}: bankCode is required for BANK payouts` },
          { status: 400 }
        );
      }
    }

    // Get user's wallet
    const userWallet = await prisma.wallet.findUnique({
      where: { userId }
    });

    if (!userWallet) {
      return NextResponse.json(
        { error: 'User wallet not found' },
        { status: 404 }
      );
    }

    // Calculate total amount and check balance
    const totalAmount = body.items.reduce(
      (sum, item) => sum + parseFloat(item.amount),
      0
    );

    // Get user's current balance
    const balances = await getAccountBalance(userWallet.address);
    const usdcBalance = balances.find((b: any) => b.asset_code === 'USDC' && b.asset_issuer === process.env.NEXT_PUBLIC_USDC_ISSUER);
    const userBalanceUSDC = usdcBalance ? parseFloat(usdcBalance.balance) : 0;

    // Calculate estimated fees (gas + platform fee + bank transfer fees where applicable)
    const estimatedGasFees = calculateEstimatedFees(body.items);
    const totalRequired = totalAmount + estimatedGasFees;

    // Check if user has sufficient balance
    if (userBalanceUSDC < totalRequired) {
      return NextResponse.json(
        {
          error: 'Insufficient balance',
          details: {
            required: totalRequired,
            available: userBalanceUSDC,
            estimatedFees: estimatedGasFees
          }
        },
        { status: 400 }
      );
    }

    // Create payout batch and items in a database transaction
    const batch = await prisma.$transaction(async (tx: any) => {
      // Create payout batch
      const payoutBatch = await tx.payoutBatch.create({
        data: {
          userId,
          totalAmount,
          totalRecipients: body.items.length,
          status: 'processing'
        }
      });

      // Create payout items
      const payoutItems = await Promise.all(
        body.items.map((item, index) =>
          tx.payoutItem.create({
            data: {
              batchId: payoutBatch.id,
              recipientIdentifier: item.recipient,
              amount: parseFloat(item.amount),
              payoutType: item.type === 'USDC' ? 'stellar_usdc' : 'ngn_bank',
              status: 'pending'
            }
          })
        )
      );

      return { batch: payoutBatch, items: payoutItems };
    });

    // Process payouts in parallel using Promise.allSettled
    const payoutPromises = body.items.map(async (item, index) => {
      const payoutItem = batch.items[index];
      const result = await processPayoutItem(item, userId, userWallet, batch.batch.id);

      // Update payout item status
      await prisma.payoutItem.update({
        where: { id: payoutItem.id },
        data: {
          status: result.success ? 'completed' : 'failed',
          txHash: result.txHash,
          errorMessage: result.errorMessage
        }
      });

      return { index, result };
    });

    const payoutResults = await Promise.allSettled(payoutPromises);

    // Count successes and failures
    let successCount = 0;
    let failureCount = 0;
    const failures: { index: number; error: string }[] = [];

    payoutResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        if (result.value.result.success) {
          successCount++;
        } else {
          failureCount++;
          failures.push({
            index,
            error: result.value.result.errorMessage || 'Unknown error'
          });
        }
      } else {
        failureCount++;
        failures.push({
          index,
          error: 'Processing failed'
        });
      }
    });

    // Update batch status
    const finalStatus =
      failureCount === 0
        ? 'completed'
        : successCount === 0
          ? 'failed'
          : 'partial_failure';

    await prisma.payoutBatch.update({
      where: { id: batch.batch.id },
      data: { status: finalStatus }
    });

    // Return response with batch summary
    return NextResponse.json({
      success: true,
      batchId: batch.batch.id,
      summary: {
        totalItems: body.items.length,
        successCount,
        failureCount,
        totalAmount,
        status: finalStatus
      },
      failures: failures.length > 0 ? failures : undefined
    });

  } catch (error) {
    console.error('Mass payout error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

// GET endpoint to retrieve batch status
export async function GET(request: NextRequest) {
  try {
    // Authenticate user
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '');
    if (!authToken) {
      return NextResponse.json(
        { error: 'Unauthorized: No auth token provided' },
        { status: 401 }
      );
    }

    const claims = await verifyAuthToken(authToken);
    if (!claims) {
      return NextResponse.json(
        { error: 'Unauthorized: Invalid token' },
        { status: 401 }
      );
    }

    // Get or create user
    let user = await prisma.user.findUnique({ where: { privyId: claims.userId } });
    if (!user) {
      const email = (claims as { email?: string }).email || `${claims.userId}@privy.local`;
      user = await prisma.user.create({ data: { privyId: claims.userId, email } });
    }

    const { searchParams } = new URL(request.url);
    const batchId = searchParams.get('batchId');

    if (!batchId) {
      return NextResponse.json(
        { error: 'batchId parameter is required' },
        { status: 400 }
      );
    }

    // Get batch with items
    const batch = await prisma.payoutBatch.findUnique({
      where: {
        id: batchId,
        userId: user.id // Ensure user can only access their own batches
      },
      include: {
        items: {
          select: {
            id: true,
            recipientIdentifier: true,
            amount: true,
            payoutType: true,
            status: true,
            errorMessage: true,
            txHash: true,
            createdAt: true
          },
          orderBy: { createdAt: 'asc' }
        }
      }
    });

    if (!batch) {
      return NextResponse.json(
        { error: 'Batch not found' },
        { status: 404 }
      );
    }

    // Calculate summary
    const successCount = batch.items.filter((item: any) => item.status === 'completed').length;
    const failureCount = batch.items.filter((item: any) => item.status === 'failed').length;
    const pendingCount = batch.items.filter((item: any) => item.status === 'pending').length;

    return NextResponse.json({
      batch: {
        id: batch.id,
        totalAmount: batch.totalAmount,
        itemCount: batch.totalRecipients,
        status: batch.status,
        createdAt: batch.createdAt,
        summary: {
          successCount,
          failureCount,
          pendingCount
        }
      },
      items: batch.items
    });

  } catch (error) {
    console.error('Get batch status error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
