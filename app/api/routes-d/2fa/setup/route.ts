import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import speakeasy from 'speakeasy'
import QRCode from 'qrcode'
import { encrypt } from '@/lib/crypto'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
    try {
        const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
        const claims = await verifyAuthToken(authToken || '')
        if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
        if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

        // Generate secret
        const secret = speakeasy.generateSecret({
            name: `LancePay (${user.email || 'User'})`,
        })

        if (!secret.base32 || !secret.otpauth_url) {
            throw new Error('Failed to generate secret')
        }

        // Generate QR code
        const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url)

        // Generate backup codes
        const backupCodes = Array.from({ length: 10 }, () => crypto.randomUUID().split('-')[0].toUpperCase())

        // Encrypt everything before storing
        const encryptedSecret = encrypt(secret.base32)
        const encryptedBackupCodes = backupCodes.map(code => encrypt(code))

        // Store temporarily (or permanently but disabled)
        await prisma.user.update({
            where: { id: user.id },
            data: {
                twoFactorSecret: encryptedSecret,
                backupCodes: encryptedBackupCodes,
                twoFactorEnabled: false // Not enabled until verified
            }
        })

        return NextResponse.json({
            secret: secret.base32,
            qrCodeUrl,
            backupCodes
        })
    } catch (error) {
        logger.error({ err: error }, '2FA Setup Error:')
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
