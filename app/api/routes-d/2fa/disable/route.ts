import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import speakeasy from 'speakeasy'
import { decrypt } from '@/lib/crypto'
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

export async function POST(request: NextRequest) {
    try {
        const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
        const claims = await verifyAuthToken(authToken || '')
        if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
        if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

        const { code, password } = await request.json()
        // NOTE: Password check skipped as User model does not have password field (Privy auth).

        if (!code) return NextResponse.json({ error: 'Code is required' }, { status: 400 })

        if (user.twoFactorEnabled && user.twoFactorSecret) {
            const secret = decrypt(user.twoFactorSecret)
            const verified = speakeasy.totp.verify({
                secret: secret,
                encoding: 'base32',
                token: code,
                window: 1
            })

            if (!verified) {
                return NextResponse.json({ error: 'Invalid 2FA code' }, { status: 401 })
            }
        }

        await prisma.user.update({
            where: { id: user.id },
            data: {
                twoFactorEnabled: false,
                twoFactorSecret: null,
                backupCodes: []
            }
        })

        if (user.email) {
            await resend.emails.send({
                from: 'LancePay <security@lancepay.com>',
                to: user.email,
                subject: '2FA Disabled',
                html: '<p>Two-factor authentication has been disabled on your account.</p>'
            })
        }

        return NextResponse.json({ success: true, message: '2FA disabled' })

    } catch (error) {
        console.error(error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
