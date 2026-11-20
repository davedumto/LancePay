import speakeasy from 'speakeasy'
import { prisma } from '@/lib/db'
import { decrypt } from '@/lib/crypto'

/** TOTP period in seconds; must match the period speakeasy assumes (default 30). */
const TOTP_PERIOD_SECONDS = 30

export type TwoFactorUser = {
  /** Local User.id — required so the last accepted TOTP step can be persisted. */
  id: string
  twoFactorEnabled: boolean
  twoFactorSecret: string | null
  lastTotpStep?: number | null
}

export type TwoFactorVerifyResult =
  | { ok: true }
  | { ok: false; status: number; error: string }

/**
 * Verify a TOTP code for a sensitive action, with replay protection.
 *
 * Replay rule: the TOTP time step that produced an accepted code is persisted
 * on `User.lastTotpStep`. A code is rejected when its step is less than or
 * equal to the stored value, so the same six-digit code cannot be reused
 * inside its ~90 second validity window (period 30s, window ±1). The step is
 * claimed with a conditional `updateMany` (`lastTotpStep < step`), which makes
 * the check-and-set atomic: two concurrent requests presenting the same code
 * cannot both succeed.
 *
 * The function is async because it performs the conditional write. Callers
 * must pass the Prisma user row (which includes `id`).
 */
export async function verifyTwoFactorForRequest(
  user: TwoFactorUser,
  code: string | undefined,
): Promise<TwoFactorVerifyResult> {
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
  const delta = speakeasy.totp.verifyDelta({
    secret,
    encoding: 'base32',
    token: code,
    window: 1,
  })

  if (!delta) {
    return { ok: false, status: 401, error: 'Invalid 2FA code' }
  }

  // verifyDelta returns the offset (in steps) between the token's counter and
  // the current counter; the matched absolute step is current + delta.
  const currentStep = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS)
  const matchedStep = currentStep + delta.delta

  // Atomically claim the step: only succeeds when it is newer than the last
  // accepted step (or none was recorded). count === 0 means replay.
  const claimed = await prisma.user.updateMany({
    where: {
      id: user.id,
      OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: matchedStep } }],
    },
    data: { lastTotpStep: matchedStep },
  })

  if (claimed.count !== 1) {
    return { ok: false, status: 401, error: 'Invalid 2FA code' }
  }

  return { ok: true }
}
