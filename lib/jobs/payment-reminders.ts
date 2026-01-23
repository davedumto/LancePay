import { prisma } from '@/lib/db'
// import { verifyAuthToken } from '@/lib/auth' 
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

export async function sendScheduledReminders() {
    console.log('🔄 Starting scheduled reminders job...')
    const today = new Date()
    today.setHours(0, 0, 0, 0) // Normalize to start of day

    // Optimized Fetch: Get all pending invoices with due dates, including settings and history
    const invoices = await prisma.invoice.findMany({
        where: {
            status: 'pending',
            dueDate: { not: null }
        },
        select: {
            id: true,
            invoiceNumber: true,
            clientEmail: true,
            clientName: true,
            amount: true,
            currency: true,
            dueDate: true,
            userId: true,
            paymentLink: true,
            user: {
                select: {
                    name: true,
                    reminderSettings: true
                }
            },
            paymentReminders: {
                select: {
                    reminderType: true,
                    daysOffset: true,
                    sentAt: true
                }
            }
        }
    })

    console.log(`Found ${invoices.length} pending invoices.`)

    const emailsToSend: Promise<any>[] = []

    for (const invoice of invoices) {
        const settings = invoice.user.reminderSettings
        if (!settings || !settings.enabled) continue

        if (!invoice.dueDate) continue // Should be filtered by query but safe check

        const dueDate = new Date(invoice.dueDate)
        dueDate.setHours(0, 0, 0, 0)

        // Calculate difference in days: (Due - Today)
        // Positive = Due in X days (Before Due)
        // Zero = Due Today
        // Negative = Overdue by X days
        const diffTime = dueDate.getTime() - today.getTime()
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))

        let reminderType: string | null = null
        let daysOffset: number | null = null

        // Check Before Due
        // If diffDays is positive, e.g., 3. settings.beforeDueDays includes 3.
        if (diffDays > 0) {
            if (settings.beforeDueDays.includes(diffDays)) {
                reminderType = 'before_due'
                daysOffset = diffDays
            }
        }
        // Check On Due
        else if (diffDays === 0) {
            if (settings.onDueEnabled) {
                reminderType = 'on_due'
                daysOffset = 0
            }
        }
        // Check Overdue
        // If diffDays is negative, e.g., -3. overdue by 3 days. 
        // settings.afterDueDays includes absolute value (3).
        else {
            const overdueDays = Math.abs(diffDays)
            if (settings.afterDueDays.includes(overdueDays)) {
                reminderType = 'overdue'
                daysOffset = overdueDays // storing positive value for offset usually cleaner or store exact diff? Schema says just 'daysOffset', I'll store the logic value (e.g. 3 for 3 days after)
            }
        }

        if (reminderType && daysOffset !== null) {
            // Check if already sent today/for this offset
            // We check if we have a reminder of this type with this offset sent recently (e.g. today)
            // Actually, for 'before_due' 3 days, it happens once. We just check if we ever sent 'before_due' with offset 3. 
            // Or simpler: check if we sent ANY 'before_due' reminder for this invoice *on this day*? No, we might have multiple schedules? Unlikely.
            // Best check: Have we sent a reminder of `reminderType` with `daysOffset` ever? 
            // Since offsets are discrete (3 days before, 1 day before), checking (type, offset) uniqueness is sufficient.

            const alreadySent = invoice.paymentReminders.some((r: any) =>
                r.reminderType === reminderType &&
                r.daysOffset === daysOffset
            )

            if (!alreadySent) {
                console.log(`Queueing ${reminderType} reminder for Invoice ${invoice.id} (Offset: ${daysOffset})`)

                emailsToSend.push(
                    processReminder(invoice, reminderType, daysOffset, settings.customMessage)
                )
            }
        }
    }

    // Batch process
    await Promise.all(emailsToSend)
    console.log(`✅ Processed ${emailsToSend.length} reminders.`)
}

async function processReminder(invoice: any, type: string, offset: number, customMessage: string | null) {
    try {
        const subjectPrefix = type === 'overdue' ? 'Overdue: ' : 'Reminder: '

        await resend.emails.send({
            from: 'LancePay <reminders@lancepay.com>',
            to: invoice.clientEmail,
            subject: `${subjectPrefix}Invoice ${invoice.invoiceNumber}`,
            html: `
            <p>Hi ${invoice.clientName || 'there'},</p>
            <p>This is a reminder for invoice <strong>${invoice.invoiceNumber}</strong>.</p>
            <p><strong>Status:</strong> ${type.replace('_', ' ').toUpperCase()}</p>
            <p><strong>Due Date:</strong> ${new Date(invoice.dueDate).toDateString()}</p>
            <p><strong>Amount:</strong> ${invoice.currency} ${invoice.amount}</p>
            ${customMessage ? `<p>${customMessage}</p>` : ''}
            <p><a href="${invoice.paymentLink}">Pay Invoice</a></p>
            `
        })

        await prisma.paymentReminder.create({
            data: {
                invoiceId: invoice.id,
                reminderType: type,
                daysOffset: offset
            }
        })
    } catch (e) {
        console.error(`Failed to send reminder for ${invoice.id}:`, e)
    }
}
