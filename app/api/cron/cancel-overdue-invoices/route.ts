import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendInvoiceCancelledEmail } from '@/lib/email'
import { logAuditEvent } from '@/lib/audit'

// Bounded per run so a large backlog can't exceed the serverless window;
// the next scheduled run resumes where this one stopped (keyset pagination
// by id means already-cancelled rows simply stop matching the where clause).
const BATCH_SIZE = Number(process.env.CANCEL_CRON_BATCH_SIZE ?? 200)
const TIME_BUDGET_MS = Number(process.env.CANCEL_CRON_TIME_BUDGET_MS ?? 50_000)
const MAX_PAGES = Number(process.env.CANCEL_CRON_MAX_PAGES ?? 50)

export async function GET(request: Request) {
    // CRON_SECRET authorization check
    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    try {
        const ninetyDaysAgo = new Date()
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

        // Eligibility predicates — reused verbatim in the conditional
        // updateMany so a concurrent status change (e.g. MoonPay marking the
        // invoice paid) makes the update a no-op instead of being overwritten.
        const eligibleWhere = {
            status: 'pending',
            dueDate: {
                lt: ninetyDaysAgo,
            },
            doNotAutoCancel: false,
            dispute: {
                is: null,
            },
            escrowEnabled: false,
        } as const

        const startedAt = Date.now()
        const cancelledIds: string[] = []
        let cancelledCount = 0
        let processed = 0
        let pages = 0
        let cursor: string | undefined
        let outOfBudget = false

        while (pages < MAX_PAGES) {
            if (Date.now() - startedAt > TIME_BUDGET_MS) {
                outOfBudget = true
                break
            }

            const page = await prisma.invoice.findMany({
                where: eligibleWhere,
                select: {
                    id: true,
                    invoiceNumber: true,
                    amount: true,
                    dueDate: true,
                    clientEmail: true,
                    // Only the fields the cancellation email needs — not the
                    // full User row.
                    user: {
                        select: { id: true, name: true, email: true },
                    },
                },
                orderBy: { id: 'asc' },
                take: BATCH_SIZE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            })
            if (page.length === 0) break
            pages++

            for (const invoice of page) {
                if (Date.now() - startedAt > TIME_BUDGET_MS) {
                    outOfBudget = true
                    break
                }
                processed++

                try {
                    // Conditional update: only cancels if the invoice is
                    // still pending and still eligible. count === 0 means a
                    // concurrent settlement/change won the race — skip the
                    // email and audit event for it.
                    const updated = await prisma.invoice.updateMany({
                        where: { id: invoice.id, ...eligibleWhere },
                        data: {
                            status: 'cancelled',
                            cancelledAt: new Date(),
                            cancellationReason: 'Auto-cancelled: 90 days overdue',
                            lienActive: false,
                        },
                    })

                    if (updated.count === 0) continue

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

                    cancelledIds.push(invoice.id)
                    cancelledCount++
                } catch (error) {
                    console.error(`Failed to automatically cancel invoice ${invoice.id}:`, error)
                    // Ensure email failures or individual invoice errors don't abort the entire run
                }
            }

            cursor = page[page.length - 1].id
            if (page.length < BATCH_SIZE) break
            if (outOfBudget) break
        }

        // Invoices still matching the eligibility predicate — i.e. the
        // backlog the next run will pick up.
        const remaining = await prisma.invoice.count({ where: eligibleWhere })

        return NextResponse.json({
            success: true,
            cancelledCount,
            processed,
            pages,
            remaining,
            outOfBudget,
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
