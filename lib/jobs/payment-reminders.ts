import { prisma } from '@/lib/db'
// import { verifyAuthToken } from '@/lib/auth' 
import { sendEmail } from '@/lib/email'

export async function sendScheduledReminders() {
    console.log('🔄 Starting scheduled reminders job...')
    const today = new Date()
    today.setHours(0, 0, 0, 0) // Normalize to start of day

    // Optimized Fetch: Get all pending invoices with due dates, including settings and history
    const invoices = await (prisma.invoice as any).findMany({
        where: {
            status: 'pending',
            dueDate: { not: null }
        },
        include: {
            user: {
                include: {
                    reminderSettings: true
                }
            },
            paymentReminders: true
        }
    })

    console.log(`Found ${invoices.length} pending invoices.`)

    const emailsToSend: Promise<any>[] = []

    for (const invoice of (invoices as any[])) {
        const settings = (invoice.user as any).reminderSettings
        if (!settings || !settings.enabled) continue

        if (!invoice.dueDate) continue 

        const dueDate = new Date(invoice.dueDate)
        dueDate.setHours(0, 0, 0, 0)

        const diffTime = dueDate.getTime() - today.getTime()
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))

        let reminderType: string | null = null
        let daysOffset: number | null = null

        if (diffDays > 0) {
            if (settings.beforeDueDays.includes(diffDays)) {
                reminderType = 'before_due'
                daysOffset = diffDays
            }
        }
        else if (diffDays === 0) {
            if (settings.onDueEnabled) {
                reminderType = 'on_due'
                daysOffset = 0
            }
        }
        else {
            const overdueDays = Math.abs(diffDays)
            if (settings.afterDueDays.includes(overdueDays)) {
                reminderType = 'overdue'
                daysOffset = overdueDays
            }
        }

        if (reminderType && daysOffset !== null) {
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

        await sendEmail({
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

        await (prisma as any).paymentReminder.create({
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
