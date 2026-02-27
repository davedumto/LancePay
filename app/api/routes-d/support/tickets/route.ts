import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

const supportTicketSchema = z.object({
    subject: z.string().min(1, 'Subject is required').max(100),
    message: z.string().min(1, 'Message is required').max(2000),
    category: z.enum(['billing', 'technical', 'general', 'account', 'other']).default('general'),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
})

export async function POST(request: NextRequest) {
    try {
        const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
        if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const claims = await verifyAuthToken(authToken)
        if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

        // Optional: Check if user exists in our DB
        const user = await prisma.user.findUnique({
            where: { privyId: claims.userId },
            select: { id: true, email: true, name: true }
        })

        const body = await request.json()
        const parsed = supportTicketSchema.safeParse(body)

        if (!parsed.success) {
            return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 })
        }

        const { subject, message, category, priority } = parsed.data

        // Dummy ticket creation
        // In a real application, we would save this to a 'SupportTicket' table
        const ticketId = `TKT-${Math.random().toString(36).substring(2, 8).toUpperCase()}`

        logger.info(`[Support Ticket Submission] User: ${user?.email || claims.userId}, Ticket: ${ticketId}, Subject: ${subject}`)

        // Simulate some "processing" time
        // await new Promise(resolve => setTimeout(resolve, 500))

        return NextResponse.json({
            success: true,
            message: 'Support ticket submitted successfully (Mock Submission)',
            ticket: {
                id: ticketId,
                subject,
                message,
                category,
                priority,
                status: 'open',
                userId: user?.id || claims.userId,
                userEmail: user?.email || (claims as any).email || 'unknown@example.com',
                createdAt: new Date().toISOString(),
            },
        }, { status: 201 })
    } catch (error) {
        logger.error({ err: error }, 'Support Ticket POST error:')
        return NextResponse.json({ error: 'Failed to submit support ticket' }, { status: 500 })
    }
}
