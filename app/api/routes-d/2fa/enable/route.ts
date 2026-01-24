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

        const { code } = await request.json()
        if (!code) return NextResponse.json({ error: 'Code is required' }, { status: 400 })

        if (!user.twoFactorSecret) {
            return NextResponse.json({ error: '2FA not initialized' }, { status: 400 })
        }

        const secret = decrypt(user.twoFactorSecret)
        const verified = speakeasy.totp.verify({
            secret: secret,
            encoding: 'base32',
            token: code,
            window: 1 // Allow 30s leeway
        })

        if (verified) {
            await prisma.user.update({
                where: { id: user.id },
                data: { twoFactorEnabled: true }
            })

            // Send confirmation email if email exists
            if (user.email) {
                await resend.emails.send({
                    from: 'LancePay <security@lancepay.com>', // Assuming domain
                    to: user.email,
                    subject: '2FA Enabled',
                    html: '<p>Two-factor authentication has been enabled on your account.</p>'
                })
            }

            return NextResponse.json({ success: true, message: '2FA enabled' })
        } else {
            return NextResponse.json({ error: 'Invalid code' }, { status: 400 })
        }
    } catch (error) {
        console.error(error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
