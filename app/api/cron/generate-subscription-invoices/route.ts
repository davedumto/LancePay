import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { generateInvoiceNumber } from '@/lib/utils'
import { sendInvoiceCreatedEmail } from '@/lib/email'
import { logAuditEvent } from '@/lib/audit'

export async function GET(request: Request) {
    // CRON_SECRET authorization check
    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    try {
        const now = new Date()

        // Find active subscriptions due for invoice generation
        const dueSubscriptions = await (prisma as any).subscription.findMany({
            where: {
                status: 'active',
                nextGenerationDate: {
                    lte: now,
                },
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

        const results = []

        for (const sub of dueSubscriptions) {
            try {
                const invoiceNumber = generateInvoiceNumber()
                const paymentLink = `${process.env.NEXT_PUBLIC_APP_URL}/pay/${invoiceNumber}`

                // Create the invoice
                const invoice = await (prisma as any).invoice.create({
                    data: {
                        userId: sub.userId,
                        subscriptionId: sub.id,
                        invoiceNumber,
                        clientEmail: sub.clientEmail,
                        clientName: sub.clientName,
                        description: sub.description,
                        amount: sub.amount,
                        currency: sub.currency,
                        paymentLink,
                        // Due date is usually 7 days from generation by default or same as generation
                        dueDate: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
                    },
                })

                // Update subscription nextGenerationDate
                const nextDate = new Date(sub.nextGenerationDate)
                if (sub.frequency === 'monthly') {
                    nextDate.setMonth(nextDate.getMonth() + sub.interval)
                } else if (sub.frequency === 'weekly') {
                    nextDate.setDate(nextDate.getDate() + (sub.interval * 7))
                }

                await (prisma as any).subscription.update({
                    where: { id: sub.id },
                    data: {
                        nextGenerationDate: nextDate,
                        lastGeneratedAt: now,
                    },
                })

                // Send notification email with template branding when available
                const brandingSettings = sub.user.brandingSettings
                const defaultTemplate = sub.user.invoiceTemplates?.[0]
                const branding = defaultTemplate
                    ? {
                        logoUrl: defaultTemplate.logoUrl ?? brandingSettings?.logoUrl ?? null,
                        primaryColor: defaultTemplate.primaryColor,
                        accentColor: defaultTemplate.accentColor,
                        footerText: defaultTemplate.footerText ?? brandingSettings?.footerText ?? null,
                    }
                    : brandingSettings
                        ? {
                            logoUrl: brandingSettings.logoUrl ?? null,
                            primaryColor: brandingSettings.primaryColor,
                            accentColor: '#059669',
                            footerText: brandingSettings.footerText ?? null,
                        }
                        : undefined

                await sendInvoiceCreatedEmail({
                    to: sub.clientEmail,
                    clientName: sub.clientName || undefined,
                    freelancerName: sub.user.name || 'Freelancer',
                    invoiceNumber: invoice.invoiceNumber,
                    description: invoice.description,
                    amount: Number(invoice.amount),
                    currency: invoice.currency,
                    paymentLink: invoice.paymentLink,
                    dueDate: invoice.dueDate!,
                    branding,
                })

                // Log audit event
                await logAuditEvent(invoice.id, 'invoice.auto_generated', null, {
                    subscriptionId: sub.id,
                    triggeredBy: 'cron'
                })

                results.push({ subscriptionId: sub.id, invoiceId: invoice.id, status: 'success' })
            } catch (error) {
                console.error(`Failed to process subscription ${sub.id}:`, error)
                results.push({ subscriptionId: sub.id, status: 'error', message: String(error) })
            }
        }

        return NextResponse.json({
            success: true,
            processed: results.length,
            details: results,
        })
    } catch (error) {
        console.error('Fatal error in subscription cron:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
