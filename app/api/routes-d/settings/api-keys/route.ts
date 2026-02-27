import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { getAuthContext } from '@/app/api/routes-d/disputes/_shared'
import { generateApiKey } from '@/lib/api-keys'
import { logger } from '@/lib/logger'

const rotateRevokeSchema = z.object({
    apiKeyId: z.string().min(1),
    action: z.enum(['rotate', 'revoke']),
})

/**
 * POST /api/routes-d/settings/api-keys
 * Rotates (replaces) or revokes (deactivates) a developer API key.
 */
export async function POST(request: NextRequest) {
    try {
        const auth = await getAuthContext(request)
        if ('error' in auth) {
            return NextResponse.json({ error: auth.error }, { status: 401 })
        }

        const body = await request.json()
        const parsed = rotateRevokeSchema.safeParse(body)

        if (!parsed.success) {
            return NextResponse.json(
                { error: parsed.error.issues[0]?.message || 'Invalid request' },
                { status: 400 }
            )
        }

        const { apiKeyId, action } = parsed.data

        // Verify ownership
        const existingKey = await prisma.apiKey.findFirst({
            where: {
                id: apiKeyId,
                userId: auth.user.id
            }
        })

        if (!existingKey) {
            return NextResponse.json({ error: 'API key not found' }, { status: 404 })
        }

        if (action === 'revoke') {
            await prisma.apiKey.update({
                where: { id: apiKeyId },
                data: { isActive: false }
            })

            return NextResponse.json({
                success: true,
                message: 'API key revoked successfully'
            })
        }

        if (action === 'rotate') {
            // 1. Generate new key
            const { fullKey, keyHint, hashedKey } = generateApiKey()

            // 2. Perform rotation in transaction: deactivate old, create new
            const rotatedKey = await prisma.$transaction(async (tx: any) => {
                // Deactivate old key
                await tx.apiKey.update({
                    where: { id: apiKeyId },
                    data: { isActive: false }
                })

                // Create new key with same name
                return await tx.apiKey.create({
                    data: {
                        userId: auth.user.id,
                        name: `${existingKey.name} (Rotated)`,
                        keyHint,
                        hashedKey,
                        isActive: true,
                    },
                    select: {
                        id: true,
                        name: true,
                        keyHint: true,
                        createdAt: true,
                    }
                })
            })

            return NextResponse.json({
                success: true,
                message: 'API key rotated successfully. Save this new key securely.',
                apiKey: {
                    ...rotatedKey,
                    key: fullKey,
                }
            })
        }

        return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    } catch (error) {
        logger.error({ err: error }, 'API key rotation POST error:')
        return NextResponse.json(
            { error: 'Failed to process API key rotation' },
            { status: 500 }
        )
    }
}
