import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { sendEmail } from '@/lib/email'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
    try {
        const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
        const claims = await verifyAuthToken(authToken || '')
        if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
        if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

        const { invoiceId, customMessage } = await request.json()
        if (!invoiceId) return NextResponse.json({ error: 'Invoice ID required' }, { status: 400 })

        const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } })
        if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

        if (invoice.userId !== user.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
        }

        // Rate Limit Check: Check if manual reminder sent in last 24h
        const lastManualReminder = await (prisma as any).paymentReminder.findFirst({
            where: {
                invoiceId,
                reminderType: 'manual',
                sentAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
            }
        })

        if (lastManualReminder) {
            return NextResponse.json({ error: 'A manual reminder was already sent in the last 24 hours.' }, { status: 429 })
        }

        // Send Email
        const { success } = await sendEmail({
            to: invoice.clientEmail,
            subject: `Reminder: Invoice ${invoice.invoiceNumber} from ${user.name || 'Freelancer'}`,
            html: `
        <p>Hi ${invoice.clientName || 'there'},</p>
        <p>This is a friendly reminder that invoice <strong>${invoice.invoiceNumber}</strong> is due on ${invoice.dueDate ? new Date(invoice.dueDate).toDateString() : 'No Due Date'}.</p>
        <p><strong>Amount Due:</strong> ${invoice.currency} ${invoice.amount}</p>
        ${customMessage ? `<p>${customMessage}</p>` : ''}
        <p><a href="${invoice.paymentLink}">Pay Invoice</a></p>
        <p>Thanks,<br>${user.name || 'Freelancer'}</p>
        `
        })

        if (!success) {
            throw new Error('Failed to send email')
        }

        // Track Reminder
        const reminder = await (prisma as any).paymentReminder.create({
            data: {
                invoiceId,
                reminderType: 'manual',
                sentAt: new Date(),
            }
        })

        return NextResponse.json({
            success: true,
            message: 'Reminder sent',
            reminderSent: {
                invoiceId,
                clientEmail: invoice.clientEmail,
                sentAt: reminder.sentAt
            }
        })

    } catch (error) {
        logger.error({ err: error }, 'Send Reminder error:')
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
