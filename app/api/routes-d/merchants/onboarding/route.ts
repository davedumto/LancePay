import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

const merchantOnboardingSchema = z.object({
    businessName: z.string().min(2, 'Business name is required').max(200),
    businessType: z.enum(['individual', 'registered_company', 'ngo', 'other']),
    registrationNumber: z.string().optional(),
    country: z.string().min(2).max(100),
    businessAddress: z.string().min(5).max(500),
    representativeName: z.string().min(2).max(200),
    representativeEmail: z.string().email(),
    expectedMonthlyVolume: z.number().positive().optional(),
})

export async function POST(request: NextRequest) {
    try {
        const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
        if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const claims = await verifyAuthToken(authToken)
        if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

        // Optional: Get user context
        const user = await prisma.user.findUnique({
            where: { privyId: claims.userId },
            select: { id: true, email: true }
        })

        const body = await request.json()
        const parsed = merchantOnboardingSchema.safeParse(body)

        if (!parsed.success) {
            return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 })
        }

        const { businessName, businessType, representativeEmail } = parsed.data

        // Mock onboarding processing
        const onboardingId = `OBD-${Math.random().toString(36).substring(2, 10).toUpperCase()}`

        logger.info(`[Merchant Onboarding Submission] User: ${user?.email || claims.userId}, OBD: ${onboardingId}, Business: ${businessName}`)

        // Simulate asynchronous KYB verification logic
        // In production, this would trigger a background job or third-party verification (e.g. SmileID)

        return NextResponse.json({
            success: true,
            message: 'Merchant onboarding data submitted successfully (Simulation)',
            data: {
                onboardingId,
                status: 'pending_verification',
                businessName,
                businessType,
                representativeEmail,
                submittedAt: new Date().toISOString(),
                estimatedCompletionDays: 2,
            }
        }, { status: 201 })
    } catch (error) {
        logger.error({ err: error }, 'Merchant Onboarding POST error:')
        return NextResponse.json({ error: 'Failed to submit onboarding data' }, { status: 500 })
    }
}
