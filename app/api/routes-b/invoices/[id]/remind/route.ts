import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { sendEmail } from '@/lib/email'

async function POSTHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 401 })
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id },
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
        { status: 422 }
      )
    }

    // Send reminder email
    const dueDateStr = invoice.dueDate
      ? new Date(invoice.dueDate).toLocaleDateString()
      : 'Not set'
    
    try {
      await sendEmail({
        to: invoice.clientEmail,
        subject: `Payment reminder: ${invoice.invoiceNumber}`,
        html: `
          <div style="font-family: system-ui, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
            <h2>Payment Reminder</h2>
            <p>This is a reminder for invoice <strong>${invoice.invoiceNumber}</strong>.</p>
            <p><strong>Amount:</strong> ${Number(invoice.amount).toFixed(2)} ${invoice.currency}</p>
            <p><strong>Due Date:</strong> ${dueDateStr}</p>
            <div style="margin: 24px 0;">
              <a href="${invoice.paymentLink}" style="display: inline-block; background: #10b981; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">Pay Now</a>
            </div>
            <p style="color: #666; font-size: 12px; margin-top: 20px;">LancePay - Get paid globally, withdraw locally</p>
          </div>
        `,
      })
    } catch (emailError) {
      console.error('Failed to send reminder email:', emailError)
      // Email failure does NOT cause the API to error as per requirements
    }

    return NextResponse.json({
      sent: true,
      clientEmail: invoice.clientEmail,
      invoiceNumber: invoice.invoiceNumber,
    })
  } catch (error) {
    console.error('Reminder POST error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export const POST = withRequestId(POSTHandler)
