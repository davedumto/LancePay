import speakeasy from 'speakeasy'
import { decrypt } from '@/lib/crypto'

export type TwoFactorUser = {
  twoFactorEnabled: boolean
  twoFactorSecret: string | null
}

export type TwoFactorVerifyResult =
  | { ok: true }
  | { ok: false; status: number; error: string }

export function verifyTwoFactorForRequest(
  user: TwoFactorUser,
  code: string | undefined,
): TwoFactorVerifyResult {
  if (!user.twoFactorEnabled) {
    return { ok: true }
  }

  if (!code) {
    return { ok: false, status: 401, error: '2FA code required' }
  }

  if (!user.twoFactorSecret) {
    return { ok: false, status: 401, error: '2FA is misconfigured; contact support' }
  }

  const secret = decrypt(user.twoFactorSecret)
  const verified = speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token: code,
    window: 1,
  })

  if (!verified) {
    return { ok: false, status: 401, error: 'Invalid 2FA code' }
  }

  return { ok: true }
}
