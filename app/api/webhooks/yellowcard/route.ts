import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendEmail } from '@/lib/email'
import crypto from 'crypto'

export async function POST(request: NextRequest) {
    try {
        const rawBody = await request.text()
        const signature = request.headers.get('x-yellowcard-signature')

        if (!rawBody || !signature) {
            return NextResponse.json({ error: 'Missing body or signature' }, { status: 400 })
        }

        // Verify webhook is from Yellow Card
        if (!verifySignature(rawBody, signature)) {
            return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
        }

        const event = JSON.parse(rawBody)

        // Handle different events
        if (event.type === 'withdrawal.completed') {
            await prisma.transaction.update({
                where: { externalId: event.data.transaction_id },
                data: { status: 'completed' }
            })

            await sendEmail({
                to: event.data.user_email,
                subject: 'Withdrawal Completed ✅',
                template: 'withdrawal-success'
            })
        }

        if (event.type === 'withdrawal.failed') {
            await prisma.transaction.update({
                where: { externalId: event.data.transaction_id },
                data: { status: 'failed', error: event.data.error_message }
            })

            await sendEmail({
                to: event.data.user_email,
                subject: 'Withdrawal Failed',
                template: 'withdrawal-failed'
            })
        }

        return NextResponse.json({ received: true })
    } catch (error) {
        return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
    }
}

function verifySignature(body: string, signature: string): boolean {
    const secret = process.env.YELLOW_CARD_WEBHOOK_SECRET!
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex')
    return signature === expected
}