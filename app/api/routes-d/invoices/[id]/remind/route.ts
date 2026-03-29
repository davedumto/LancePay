import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { sendEmail } from '@/lib/email'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    select: {
      userId: true,
      status: true,
      clientEmail: true,
      invoiceNumber: true,
      amount: true,
      currency: true,
      dueDate: true,
      paymentLink: true,
    },
  })

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  if (invoice.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (invoice.status !== 'pending') {
    return NextResponse.json(
      { error: 'Reminders can only be sent for pending invoices' },
      { status: 422 },
    )
  }

  const dueDateStr = invoice.dueDate
    ? new Date(invoice.dueDate).toLocaleDateString()
    : 'Not set'
  const amountStr = Number(invoice.amount).toFixed(2)

  try {
    await sendEmail({
      to: invoice.clientEmail,
      subject: `Payment reminder: ${invoice.invoiceNumber}`,
      html: `
        <div style="font-family: system-ui, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
          <h2>Payment reminder</h2>
          <p>This is a friendly reminder about invoice <strong>${invoice.invoiceNumber}</strong>.</p>
          <p><strong>Amount owed:</strong> ${amountStr} ${invoice.currency}</p>
          <p><strong>Due date:</strong> ${dueDateStr}</p>
          <p><a href="${invoice.paymentLink}" style="display: inline-block; background: #10b981; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">Pay now</a></p>
          <p style="color: #666; font-size: 12px; margin-top: 20px;">LancePay — Get paid globally, withdraw locally</p>
        </div>
      `,
    })
  } catch (err) {
    console.error('Payment reminder email failed:', err)
  }

  return NextResponse.json({
    sent: true,
    clientEmail: invoice.clientEmail,
  })
}
