import { PrivyClient, type AuthTokenClaims } from '@privy-io/server-auth'
import { prisma } from '@/lib/db'
import { hashToken } from '@/lib/crypto'

const privy = new PrivyClient(
  process.env.NEXT_PUBLIC_PRIVY_APP_ID!,
  process.env.PRIVY_APP_SECRET!
)

/**
 * Verify a Privy auth token and enforce session revocation.
 *
 * Revocation is enforced against the session row upserted from the verified
 * `claims.sessionId`: the row is keyed by `providerSessionId`, and a token is
 * rejected when that row has a `revokedAt` value or belongs to another user.
 *
 * A verified token whose `privyId` has no local `User` row is treated as
 * UNAUTHENTICATED (returns null): without a user row there is no session to
 * check for revocation, so accepting the claims would let tokens for deleted
 * or never-provisioned accounts bypass revocation entirely. Routes that
 * legitimately provision a user on first login must use
 * {@link verifyAuthTokenForProvisioning} instead.
 *
 * @param token - The bearer token issued by Privy
 * @returns The verified claims for an active session, or null if invalid/revoked/unprovisioned
 */
export async function verifyAuthToken(token: string): Promise<AuthTokenClaims | null> {
  return verifyAuthTokenInternal(token, { allowUnprovisioned: false })
}

/**
 * Verify a Privy auth token for first-login provisioning routes only.
 *
 * Identical to {@link verifyAuthToken} except that a verified token with no
 * matching `User` row is allowed through so the route can create the user.
 * Once the user exists the same session-revocation checks apply, so this must
 * only be used by routes that actually perform provisioning
 * (currently `/api/user/profile`, `/api/user/balance`, `/api/user/sync-wallet`).
 * All other routes must use {@link verifyAuthToken}.
 *
 * @param token - The bearer token issued by Privy
 * @returns The verified claims, or null if invalid/revoked
 */
export async function verifyAuthTokenForProvisioning(
  token: string,
): Promise<AuthTokenClaims | null> {
  return verifyAuthTokenInternal(token, { allowUnprovisioned: true })
}

async function verifyAuthTokenInternal(
  token: string,
  { allowUnprovisioned }: { allowUnprovisioned: boolean },
): Promise<AuthTokenClaims | null> {
  try {
    const claims = await privy.verifyAuthToken(token)

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) return allowUnprovisioned ? claims : null
    if (!claims.sessionId) return claims

    const session = await prisma.userSession.upsert({
      where: { providerSessionId: claims.sessionId },
      create: {
        providerSessionId: claims.sessionId,
        userId: user.id,
        tokenHint: claims.sessionId.slice(-12),
      },
      update: { lastSeenAt: new Date() },
      select: { userId: true, revokedAt: true },
    })
    if (session.userId !== user.id || session.revokedAt) return null

    return claims
  } catch {
    return null
  }
}

/**
 * Verify an API key from the request and return the associated user.
 * 
 * A key is valid if:
 * - It exists in the database (hashedKey matches)
 * - isActive is true
 * - deactivatesAt is null OR deactivatesAt > now (grace period check)
 * 
 * This allows old keys to remain valid during the grace period after rotation.
 * 
 * @param rawApiKey - The raw API key from the request header
 * @returns Object with userId and full apiKey record, or null if invalid
 */
export async function verifyApiKey(
  rawApiKey: string | null | undefined
): Promise<{ userId: string; apiKey: any } | null> {
  if (!rawApiKey) return null

  try {
    const hashedKey = hashToken(rawApiKey)

    const apiKey = await prisma.apiKey.findUnique({
      where: { hashedKey },
      select: {
        id: true,
        userId: true,
        name: true,
        isActive: true,
        deactivatesAt: true,
        lastUsedAt: true,
        createdAt: true,
      },
    })

    if (!apiKey) return null

    // Check if key is active
    if (!apiKey.isActive) return null

    // Check grace period: if deactivatesAt is set and is in the past, key is no longer valid
    const now = new Date()
    if (apiKey.deactivatesAt && apiKey.deactivatesAt <= now) {
      return null
    }

    // Key is valid - update lastUsedAt
    await prisma.apiKey.update(
      {
        where: { id: apiKey.id },
        data: { lastUsedAt: now },
      }
    ).catch(() => {
      // Silently fail on lastUsedAt update - don't block request on this
    })

    return { userId: apiKey.userId, apiKey }
  } catch (error) {
    // Any error during verification means invalid key
    return null
  }
}
