import { PrivyClient, type AuthTokenClaims } from '@privy-io/server-auth'
import { prisma } from '@/lib/db'
import { hashToken } from '@/lib/crypto'

const privy = new PrivyClient(
  process.env.NEXT_PUBLIC_PRIVY_APP_ID!,
  process.env.PRIVY_APP_SECRET!
)

export async function verifyAuthToken(token: string): Promise<AuthTokenClaims | null> {
  try {
    return await privy.verifyAuthToken(token)
  } catch {
    return null
  }
}

const revokedKeyIds = new Set<string>()
const revokedKeyHashes = new Set<string>()

/**
 * Immediately marks an API key as revoked in the in-process request-time cache
 * so in-flight or cached lookups reject the key without waiting for TTL expiry.
 */
export function invalidateApiKeyCache(keyId: string, hashedKey?: string | null): void {
  if (keyId) revokedKeyIds.add(keyId)
  if (hashedKey) revokedKeyHashes.add(hashedKey)
}

export function clearApiKeyRevocationCache(): void {
  revokedKeyIds.clear()
  revokedKeyHashes.clear()
}

export function isApiKeyRevokedInCache(keyId?: string | null, hashedKey?: string | null): boolean {
  if (keyId && revokedKeyIds.has(keyId)) return true
  if (hashedKey && revokedKeyHashes.has(hashedKey)) return true
  return false
}

/**
 * Verify an API key from the request and return the associated user.
 * 
 * A key is valid if:
 * - It exists in the database (hashedKey matches)
 * - It has not been invalidated in the request-time revocation cache
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
    if (isApiKeyRevokedInCache(null, hashedKey)) {
      return null
    }

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

    if (isApiKeyRevokedInCache(apiKey.id, hashedKey)) {
      return null
    }

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
