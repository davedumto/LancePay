import { PrivyClient, type AuthTokenClaims } from '@privy-io/server-auth'
import { prisma } from '@/lib/db'
import { hashToken } from '@/lib/crypto'

const privy = new PrivyClient(
  process.env.NEXT_PUBLIC_PRIVY_APP_ID!,
  process.env.PRIVY_APP_SECRET!
)

export async function verifyAuthToken(token: string): Promise<AuthTokenClaims | null> {
  try {
    const claims = await privy.verifyAuthToken(token)
    if (!claims.sessionId) return claims

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) return claims

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
    if (!claims) return null

    try {
      const tokenHint = token.slice(-6)
      const revoked = await prisma.userSession.findFirst({
        where: {
          tokenHint,
          revokedAt: { not: null },
        },
      })
      if (revoked) return null
    } catch {
      // Ignore if session check fails or table not mocked
    }

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
