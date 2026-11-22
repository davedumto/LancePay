import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendInvoiceCancelledEmail } from '@/lib/email'
import { logAuditEvent } from '@/lib/audit'

export async function GET(request: Request) {
    // CRON_SECRET authorization check
    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    try {
        const ninetyDaysAgo = new Date()
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

        // Fetch eligible invoices with exclusion logic in the where clause
        const eligibleInvoices = await prisma.invoice.findMany({
            where: {
                status: 'pending',
                dueDate: {
                    lt: ninetyDaysAgo,
                },
                doNotAutoCancel: false,
                dispute: {
                    is: null,
                },
                escrowEnabled: false,
            },
            include: {
                user: true,
            },
        })

        const cancelledIds: string[] = []
        let cancelledCount = 0

        for (const invoice of eligibleInvoices) {
            try {
                // Execute status update and audit log in a single atomic transaction
                await prisma.$transaction(async (tx) => {
                    await tx.invoice.update({
                        where: { id: invoice.id },
                        data: {
                            status: 'cancelled',
                            cancelledAt: new Date(),
                            cancellationReason: 'Auto-cancelled: 90 days overdue',
                            lienActive: false,
                        },
                    })

                    // Log audit event passing the transaction client
                    await logAuditEvent(
                        invoice.id,
                        'invoice.auto_cancelled',
                        null, // system actor
                        { reason: 'Auto-cancelled: 90 days overdue' },
                        tx
                    )
                })

                // Fire-and-forget cancellation email after successful transaction commit
                try {
                    const daysOverdue = Math.floor(
                        (new Date().getTime() - new Date(invoice.dueDate!).getTime()) / (1000 * 60 * 60 * 24)
                    )

                    if (invoice.user?.name && invoice.user?.email) {
                        const emailSent = await sendInvoiceCancelledEmail({
                            to: invoice.user.email,
                            freelancerName: invoice.user.name,
                            invoiceNumber: invoice.invoiceNumber,
                            amount: Number(invoice.amount),
                            dueDate: invoice.dueDate!,
                            daysOverdue,
                            clientEmail: invoice.clientEmail,
                        })

                        if (!emailSent || !emailSent.success) {
                            console.warn(`Failed to send cancellation email for invoice ${invoice.id}`)
                        }
                    }
                } catch (emailError) {
                    console.error(`Failed to send cancellation email for invoice ${invoice.id}:`, emailError)
                }

                cancelledIds.push(invoice.id)
                cancelledCount++
            } catch (error) {
                console.error(`Failed to automatically cancel invoice ${invoice.id}:`, error)
                // Transaction rollback ensures invoice remains in pending state without partial updates
            }
        }

        return NextResponse.json({
            success: true,
            cancelledCount,
            cancelledInvoiceIds: cancelledIds,
        })
    } catch (error) {
        console.error('Fatal error running auto-cancellation cron:', error)
        return NextResponse.json(
            { error: 'Internal server error processing cron jobs' },
            { status: 500 }
        )
    }
}
