import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import speakeasy from 'speakeasy'
import { decrypt, timingSafeEqual } from '@/lib/crypto'
import { logger } from '@/lib/logger'
import { getClientIp, twoFactorLimiter as rateLimiter } from '@/lib/rate-limit'

export async function POST(request: NextRequest) {
    try {
        const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
        const claims = await verifyAuthToken(authToken || '')
        if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
        if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

        // Rate limit: composite key of IP + userId
        const clientIp = getClientIp(request)
        const rateLimitKey = `${clientIp}:${user.id}`
        const rateLimit = rateLimiter.check(rateLimitKey)

        if (!rateLimit.allowed) {
            const retryAfterSeconds = Math.max(
                1,
                Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
            )
            const response = NextResponse.json(
                { error: 'Too many verification attempts. Try again later.' },
                { status: 429 },
            )
            response.headers.set('Retry-After', String(retryAfterSeconds))
            response.headers.set('X-RateLimit-Limit', String(rateLimit.limit))
            response.headers.set('X-RateLimit-Remaining', '0')
            response.headers.set('X-RateLimit-Reset', String(Math.floor(rateLimit.resetAt / 1000)))
            response.headers.set('X-RateLimit-Policy', rateLimit.policyId)
            return response
        }

        const { code } = await request.json()
        if (!code) return NextResponse.json({ error: 'Code is required' }, { status: 400 })

        if (!user.twoFactorEnabled || !user.twoFactorSecret) {
            return NextResponse.json({ valid: false, message: '2FA not enabled' })
        }

        const secret = decrypt(user.twoFactorSecret)
        const verified = speakeasy.totp.verify({
            secret: secret,
            encoding: 'base32',
            token: code,
            window: 1
        })

        if (verified) {
            rateLimiter.reset(rateLimitKey)
            return NextResponse.json({ valid: true })
        }

        // Check backup codes
        if (user.backupCodes && user.backupCodes.length > 0) {
            let usedBackupCodeIndex = -1;
            for (let i = 0; i < user.backupCodes.length; i++) {
                const dec = decrypt(user.backupCodes[i])
                if (timingSafeEqual(dec, code)) {
                    usedBackupCodeIndex = i;
                    break;
                }
            }

            if (usedBackupCodeIndex !== -1) {
                const updatedBackupCodes = [...user.backupCodes]
                updatedBackupCodes.splice(usedBackupCodeIndex, 1)

                await prisma.user.update({
                    where: { id: user.id },
                    data: { backupCodes: updatedBackupCodes }
                })
                rateLimiter.reset(rateLimitKey)
                return NextResponse.json({ valid: true, backupCodeUsed: true })
            }
        }

        console.warn('[2FA] Failed verification attempt', {
            userId: user.id,
            ip: clientIp,
            remaining: rateLimit.remaining,
        })

        return NextResponse.json({ valid: false })

    } catch (error) {
        logger.error(error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
