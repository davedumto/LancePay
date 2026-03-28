import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma'; // standard project import path
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST(req: NextRequest) {
  // 1. Get raw body for signature verification (critical — never use JSON.parse first)
  const rawBody = await req.text();

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

  if (computedSignature !== signature) {
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

  // 5. Find Withdrawal record (by reference first — our internal ID — or transactionId)
  const withdrawal = await prisma.withdrawal.findFirst({
    where: {
      OR: [
        reference ? { reference } : undefined,
        transactionId ? { transactionId } : undefined,
      ].filter(Boolean),
    },
  });

  if (!withdrawal) {
    console.warn(`Unknown withdrawal — reference: ${reference}, transactionId: ${transactionId}`);
    // Always ACK with 200 (standard webhook practice — never expose unknown records)
    return NextResponse.json({ received: true }, { status: 200 });
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

  // 7. Update record + flag failed withdrawals for manual review
  await prisma.withdrawal.update({
    where: { id: withdrawal.id },
    data: {
      status: newStatus,
      ...(reason && { reason }),
      // Flag for manual review on failure (field assumed present from #280)
      ...( (payloadStatus === 'failed' || payloadStatus === 'reversed') && { needsManualReview: true } ),
    },
  });

  // 8. If failed → send admin alert email
  if (payloadStatus === 'failed' || payloadStatus === 'reversed') {
    try {
      await resend.emails.send({
        from: 'LancePay Alerts <no-reply@lancepay.com>',
        to: process.env.ADMIN_EMAIL || 'admin@lancepay.com',
        subject: `🚨 Withdrawal Failed — ${reference || transactionId}`,
        html: `
          <h1>Off-ramp Failure Alert</h1>
          <p><strong>Withdrawal ID:</strong> ${reference || transactionId}</p>
          <p><strong>Status:</strong> ${payloadStatus}</p>
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
    { received: true, withdrawalId: withdrawal.id, status: newStatus },
    { status: 200 }
  );
}