import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import speakeasy from 'speakeasy'
import { decrypt, timingSafeEqual } from '@/lib/crypto'

export async function POST(request: NextRequest) {
    try {
        const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
        const claims = await verifyAuthToken(authToken || '')
        if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
        if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

        const { code } = await request.json()
        if (!code) return NextResponse.json({ error: 'Code is required' }, { status: 400 })

        if (!user.twoFactorEnabled || !user.twoFactorSecret) {
            // If 2FA is not enabled, technically verification is "valid" in that no 2FA is needed, 
            // but this endpoint implies checking a code. We returns false.
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
            return NextResponse.json({ valid: true })
        }

        // Check backup codes
        if (user.backupCodes && user.backupCodes.length > 0) {
            // We need to decrypt all backup codes to check. 
            // In a more optimized way we might hash them, but sticking to "encrypt/decrypt" prompt requirement.

            let usedBackupCodeIndex = -1;
            for (let i = 0; i < user.backupCodes.length; i++) {
                const dec = decrypt(user.backupCodes[i])
                if (timingSafeEqual(dec, code)) {
                    usedBackupCodeIndex = i;
                    break;
                }
            }

            if (usedBackupCodeIndex !== -1) {
                // Remove used backup code
                const updatedBackupCodes = [...user.backupCodes]
                updatedBackupCodes.splice(usedBackupCodeIndex, 1)

                await prisma.user.update({
                    where: { id: user.id },
                    data: { backupCodes: updatedBackupCodes }
                })
                return NextResponse.json({ valid: true, backupCodeUsed: true })
            }
        }

        return NextResponse.json({ valid: false })

    } catch (error) {
        console.error(error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
