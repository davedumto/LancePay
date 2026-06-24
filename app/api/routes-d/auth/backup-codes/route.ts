import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import speakeasy from 'speakeasy'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { decrypt, hashToken } from '@/lib/crypto'
import { logger } from '@/lib/logger'

// ── POST /api/routes-d/auth/backup-codes — generate 2FA backup codes ──
//
// Backup codes are one-time recovery secrets. Plaintext codes are returned
// exactly once; only SHA-256 hashes are persisted on the user record.

const BACKUP_CODE_COUNT = 10
const BACKUP_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function generateBackupCode(): string {
  const bytes = crypto.randomBytes(8)
  return Array.from(bytes, (byte) => BACKUP_CODE_ALPHABET[byte % BACKUP_CODE_ALPHABET.length]).join('')
}

function generateBackupCodes(): string[] {
  return Array.from({ length: BACKUP_CODE_COUNT }, () => generateBackupCode())
}

async function verifyTwoFactorCode(
  user: { twoFactorSecret: string | null },
  code: unknown,
): Promise<boolean> {
  if (!user.twoFactorSecret) return false
  const secret = decrypt(user.twoFactorSecret)
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token: String(code),
    window: 1,
  })
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, twoFactorEnabled: true, twoFactorSecret: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    if (!user.twoFactorEnabled) {
      return NextResponse.json(
        { error: 'Two-factor authentication must be enabled before generating backup codes' },
        { status: 409 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      body = {}
    }

    const code = (body as { code?: unknown } | null)?.code
    if (!code || typeof code !== 'string') {
      return NextResponse.json({ error: '2FA code required' }, { status: 401 })
    }

    const verified = await verifyTwoFactorCode(user, code)
    if (!verified) {
      return NextResponse.json({ error: 'Invalid 2FA code' }, { status: 401 })
    }

    const backupCodes = generateBackupCodes()
    const generatedAt = new Date()

    await prisma.user.update({
      where: { id: user.id },
      data: { backupCodes: backupCodes.map(hashToken) },
    })

    return NextResponse.json({
      backupCodes,
      count: backupCodes.length,
      generatedAt: generatedAt.toISOString(),
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/auth/backup-codes error')
    return NextResponse.json({ error: 'Failed to generate backup codes' }, { status: 500 })
  }
}
