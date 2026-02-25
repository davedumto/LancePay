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
                user: {
                    include: {
                        brandingSettings: true,
                        invoiceTemplates: {
                            where: { isDefault: true },
                            orderBy: { createdAt: 'asc' },
                            take: 1,
                        },
                    },
                },
            },
        })

        const cancelledIds: string[] = []
        let cancelledCount = 0

        for (const invoice of eligibleInvoices) {
            try {
                // Atomic update for status and lien release
                const updatedInvoice = await prisma.invoice.update({
                    where: { id: invoice.id },
                    data: {
                        status: 'cancelled',
                        cancelledAt: new Date(),
                        cancellationReason: 'Auto-cancelled: 90 days overdue',
                        lienActive: false,
                    },
                })

                // Log audit event
                await logAuditEvent(
                    invoice.id,
                    'invoice.auto_cancelled',
                    null, // system actor
                    { reason: 'Auto-cancelled: 90 days overdue' }
                )

                // Calculate days overdue
                const daysOverdue = Math.floor(
                    (new Date().getTime() - new Date(invoice.dueDate!).getTime()) / (1000 * 60 * 60 * 24)
                )

                // Send cancellation email to freelancer
                if (invoice.user?.name && invoice.user?.email) {
                    const brandingSettings = invoice.user.brandingSettings
                    const defaultTemplate = invoice.user.invoiceTemplates?.[0]

                    const branding = defaultTemplate
                        ? {
                              logoUrl: defaultTemplate.logoUrl ?? brandingSettings?.logoUrl ?? null,
                              primaryColor: defaultTemplate.primaryColor,
                              accentColor: defaultTemplate.accentColor,
                              footerText:
                                  defaultTemplate.footerText ?? brandingSettings?.footerText ?? null,
                          }
                        : brandingSettings
                        ? {
                              logoUrl: brandingSettings.logoUrl ?? null,
                              primaryColor: brandingSettings.primaryColor,
                              accentColor: '#059669',
                              footerText: brandingSettings.footerText ?? null,
                          }
                        : undefined

                    const emailSent = await sendInvoiceCancelledEmail({
                        to: invoice.user.email,
                        freelancerName: invoice.user.name,
                        invoiceNumber: invoice.invoiceNumber,
                        amount: Number(invoice.amount),
                        dueDate: invoice.dueDate!,
                        daysOverdue,
                        clientEmail: invoice.clientEmail,
                        branding,
                    })

                    if (!emailSent || !emailSent.success) {
                        console.warn(`Failed to send cancellation email for invoice ${invoice.id}`)
                    }
                }

                cancelledIds.push(invoice.id)
                cancelledCount++
            } catch (error) {
                console.error(`Failed to automatically cancel invoice ${invoice.id}:`, error)
                // Ensure email failures or individual invoice errors don't abort the entire run
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
