import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
    try {
        const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
        const claims = await verifyAuthToken(authToken || '')
        if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
        if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

        const { searchParams } = new URL(request.url)
        const invoiceId = searchParams.get('invoiceId')

        if (!invoiceId) return NextResponse.json({ error: 'Invoice ID is required' }, { status: 400 })

        const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } })
        if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

        if (invoice.userId !== user.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
        }

        const reminders = await prisma.paymentReminder.findMany({
            where: { invoiceId },
            orderBy: { sentAt: 'desc' },
            select: {
                id: true,
                reminderType: true,
                sentAt: true,
                daysOffset: true
            }
        })

        return NextResponse.json({ reminders })
    } catch (error) {
        logger.error({ err: error }, 'History GET error:')
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
