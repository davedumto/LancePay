import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { prisma } from '@/lib/db';
import { Resend } from 'resend';
import { timingSafeEqual } from '@/lib/crypto';
import { ADMIN_EMAILS } from '@/lib/authorization';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'reversed']);

export async function POST(req: NextRequest) {
  let rawBody = '';
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    // 1. Get raw body for signature verification (critical — never use JSON.parse first)
    rawBody = await req.text();

    const signature = req.headers.get('x-yc-signature');
    const secret = process.env.OFFRAMP_WEBHOOK_SECRET;

    if (!secret) {
      console.error('OFFRAMP_WEBHOOK_SECRET is missing');
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    if (!signature) {
      return NextResponse.json({ error: 'Missing X-YC-Signature header' }, { status: 401 });
    }

    // 2. Verify HMAC-SHA256 signature (Yellow Card standard: base64 of HMAC using webhook secret)
    const computedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    if (!timingSafeEqual(computedSignature, signature)) {
      console.warn('⚠️ Invalid webhook signature — possible tampering');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    // 3. Parse payload (safe after signature check)
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    // 4. Adapt to actual Yellow Card schema while matching the expected fields in the ticket
    const { transactionId, status: payloadStatus, reference, reason } = payload;

    if (!reference && !transactionId) {
      return NextResponse.json({ error: 'Missing reference or transactionId' }, { status: 400 });
    }

    // 5. Find WithdrawalTransaction record (by stellarTxId or internal id)
    const withdrawal = await prisma.withdrawalTransaction.findFirst({
      where: {
        OR: [
          transactionId ? { stellarTxId: transactionId } : undefined,
          reference ? { id: reference } : undefined,
        ].filter(Boolean) as object[],
      },
    });

    if (!withdrawal) {
      console.warn(`Unknown withdrawal — reference: ${reference}, transactionId: ${transactionId}`);
      // Always ACK with 200 (standard webhook practice — never expose unknown records)
      return NextResponse.json({ received: true }, { status: 200 });
    }

    // Guard against modifying a withdrawal that is already in a terminal state
    if (withdrawal.status && TERMINAL_STATUSES.has(withdrawal.status.toLowerCase())) {
      console.warn(
        `Withdrawal ${withdrawal.id} is already in terminal state "${withdrawal.status}". Ignoring update to "${payloadStatus}".`
      );
      return NextResponse.json(
        { received: true, ignored: true, withdrawalTransactionId: withdrawal.id, status: withdrawal.status },
        { status: 200 }
      );
    }

    // 6. Map status (completed / failed / reversed)
    let newStatus: string;
    switch (payloadStatus?.toLowerCase()) {
      case 'completed':
        newStatus = 'completed';
        break;
      case 'failed':
      case 'reversed':
        newStatus = payloadStatus.toLowerCase();
        break;
      default:
        newStatus = payloadStatus || 'pending';
    }

    // 7. Update record
    await prisma.withdrawalTransaction.update({
      where: { id: withdrawal.id },
      data: {
        status: newStatus,
        ...(reason && { error: reason }),
      },
    });

    // 8. If failed → send admin alert email
    if (newStatus === 'failed' || newStatus === 'reversed') {
      try {
        await resend.emails.send({
          from: 'LancePay Alerts <no-reply@lancepay.com>',
          to: ADMIN_EMAILS.length ? ADMIN_EMAILS : ['admin@lancepay.com'],
          subject: `🚨 Withdrawal Failed — ${reference || transactionId}`,
          html: `
            <h1>Off-ramp Failure Alert</h1>
            <p><strong>Withdrawal ID:</strong> ${reference || transactionId}</p>
            <p><strong>Status:</strong> ${newStatus}</p>
            <p><strong>Reason:</strong> ${reason || 'No reason provided'}</p>
            <p>Please review and handle manually in the dashboard.</p>
          `,
        });
        console.log('✅ Admin alert email sent');
      } catch (err) {
        console.error('Failed to send admin email:', err);
      }
    }

    // 9. Always return 200 for valid webhooks
    return NextResponse.json(
      { received: true, withdrawalTransactionId: withdrawal.id, status: newStatus },
      { status: 200 }
    );
  } catch (error) {
    console.error('Webhook processing failed for raw payload:', rawBody, error);
    return NextResponse.json({ error: 'Webhook processing error' }, { status: 500 });
  }
}