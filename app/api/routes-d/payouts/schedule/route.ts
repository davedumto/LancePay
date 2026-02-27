import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyAuthToken } from '@/lib/auth';
import { getAccountBalance, isValidStellarAddress } from '@/lib/stellar';

interface SchedulePayoutItem {
  amount: string;
  recipient: string;
  type: 'USDC' | 'BANK';
  bankCode?: string;
}

interface SchedulePayoutRequest {
  items: SchedulePayoutItem[];
  scheduledFor: string; // ISO date string
}

// reuse some helpers from mass route (could be moved to shared module if needed)
function isValidNUBAN(accountNumber: string): boolean {
  return /^\d{10}$/.test(accountNumber);
}
function isValidBankCode(bankCode: string): boolean {
  return /^\d{3}$/.test(bankCode);
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '');
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized: No auth token provided' }, { status: 401 });
    }

    const claims = await verifyAuthToken(authToken);
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized: Invalid token' }, { status: 401 });
    }

    let user = await prisma.user.findUnique({ where: { privyId: claims.userId } });
    if (!user) {
      const email = (claims as { email?: string }).email || `${claims.userId}@privy.local`;
      user = await prisma.user.create({ data: { privyId: claims.userId, email } });
    }
    const userId = user.id;

    const body: SchedulePayoutRequest = await request.json();

    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      return NextResponse.json({ error: 'Invalid request: items array is required' }, { status: 400 });
    }

    if (!body.scheduledFor) {
      return NextResponse.json({ error: 'scheduledFor timestamp is required' }, { status: 400 });
    }

    const scheduledDate = new Date(body.scheduledFor);
    if (isNaN(scheduledDate.getTime())) {
      return NextResponse.json({ error: 'scheduledFor must be a valid ISO date' }, { status: 400 });
    }
    if (scheduledDate.getTime() <= Date.now()) {
      return NextResponse.json({ error: 'scheduledFor must be in the future' }, { status: 400 });
    }

    if (body.items.length > 100) {
      return NextResponse.json(
        { error: 'Too many items: maximum 100 items per schedule' },
        { status: 400 }
      );
    }

    // validate each item similarly to mass route
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

    // ensure wallet exists
    const userWallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!userWallet) {
      return NextResponse.json({ error: 'User wallet not found' }, { status: 404 });
    }

    // check balance now to give user immediate feedback
    const totalAmount = body.items.reduce((sum, item) => sum + parseFloat(item.amount), 0);
    const balances = await getAccountBalance(userWallet.address);
    const usdcBalance = balances.find((b: any) => b.asset_code === 'USDC' && b.asset_issuer === process.env.NEXT_PUBLIC_USDC_ISSUER);
    const userBalanceUSDC = usdcBalance ? parseFloat(usdcBalance.balance) : 0;

    // simple fee estimate: copy calculateEstimatedFees from mass route (importing would require refactor)
    const PLATFORM_FEE_RATE = 0.005;
    const BANK_TRANSFER_FEE_USDC = 0.3;
    const calculateEstimatedFees = (items: SchedulePayoutItem[]) => {
      let total = 0;
      for (const item of items) {
        const amount = parseFloat(item.amount);
        const platformFee = amount * PLATFORM_FEE_RATE;
        const gasFeeUSDC = 0.1;
        if (item.type === 'BANK') {
          total += platformFee + gasFeeUSDC + BANK_TRANSFER_FEE_USDC;
        } else {
          total += platformFee + gasFeeUSDC;
        }
      }
      return parseFloat(total.toFixed(7));
    };

    const estimatedFees = calculateEstimatedFees(body.items);
    const totalRequired = totalAmount + estimatedFees;
    if (userBalanceUSDC < totalRequired) {
      return NextResponse.json(
        { error: 'Insufficient balance', details: { required: totalRequired, available: userBalanceUSDC, estimatedFees } },
        { status: 400 }
      );
    }

    // create scheduled batch
    const batch = await prisma.payoutBatch.create({
      data: {
        userId,
        totalAmount,
        totalRecipients: body.items.length,
        status: 'scheduled',
        scheduledAt: scheduledDate,
      }
    });

    // create items
    await Promise.all(
      body.items.map((item) =>
        prisma.payoutItem.create({
          data: {
            batchId: batch.id,
            recipientIdentifier: item.recipient,
            amount: parseFloat(item.amount),
            payoutType: item.type === 'USDC' ? 'stellar_usdc' : 'ngn_bank',
            status: 'pending'
          }
        })
      )
    );

    return NextResponse.json({
      success: true,
      batchId: batch.id,
      scheduledFor: scheduledDate.toISOString(),
      summary: { totalItems: body.items.length, totalAmount }
    });
  } catch (error: any) {
    console.error('Schedule payout error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to schedule payout' },
      { status: 500 }
    );
  }
}
