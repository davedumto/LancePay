import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(request: NextRequest) {
    try {
        const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
        const claims = await verifyAuthToken(authToken || '')
        if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const user = await prisma.user.findUnique({
            where: { privyId: claims.userId },
            include: { reminderSettings: true }
        })

        if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

        const settings = user.reminderSettings || {
            enabled: true,
            beforeDueDays: [3, 1],
            onDueEnabled: true,
            afterDueDays: [1, 3, 7],
            customMessage: null
        }

        return NextResponse.json(settings)
    } catch (error) {
        console.error('Settings GET error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

export async function PUT(request: NextRequest) {
    try {
        const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
        const claims = await verifyAuthToken(authToken || '')
        if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
        if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

        const body = await request.json()
        const { enabled, beforeDueDays, onDueEnabled, afterDueDays, customMessage } = body

        const settings = await prisma.reminderSettings.upsert({
            where: { userId: user.id },
            create: {
                userId: user.id,
                enabled: enabled ?? true,
                beforeDueDays: beforeDueDays ?? [3, 1],
                onDueEnabled: onDueEnabled ?? true,
                afterDueDays: afterDueDays ?? [1, 3, 7],
                customMessage
            },
            update: {
                enabled,
                beforeDueDays,
                onDueEnabled,
                afterDueDays,
                customMessage
            }
        })

        return NextResponse.json(settings)
    } catch (error) {
        console.error('Settings PUT error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
