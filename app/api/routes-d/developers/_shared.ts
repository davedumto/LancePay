import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { hashApiKey, isValidApiKeyFormat } from '@/lib/api-keys'

export interface ApiKeyAuthResult {
  success: true
  user: { id: string; email: string; name: string | null }
  apiKeyId: string
}

export interface ApiKeyAuthError {
  success: false
  error: string
  statusCode: 401 | 403 | 429
}

export async function authenticateApiKey(
  request: NextRequest
): Promise<ApiKeyAuthResult | ApiKeyAuthError> {
  const apiKey = request.headers.get('X-API-Key')

  if (!apiKey) {
    return { success: false, error: 'Missing X-API-Key header', statusCode: 401 }
  }

  // Validate format first (quick check before DB query)
  if (!isValidApiKeyFormat(apiKey)) {
    return { success: false, error: 'Invalid API key format', statusCode: 401 }
  }

  // Hash the provided key
  const hashedKey = hashApiKey(apiKey)

  // Find API key in database
  const apiKeyRecord = await prisma.apiKey.findUnique({
    where: { hashedKey },
    include: {
      user: {
        select: { id: true, email: true, name: true }
      }
    }
  })

  if (!apiKeyRecord) {
    return { success: false, error: 'Invalid API key', statusCode: 401 }
  }

  // Check if key is active
  if (!apiKeyRecord.isActive) {
    return { success: false, error: 'API key is inactive', statusCode: 403 }
  }

  // Update last used timestamp (async, don't wait)
  prisma.apiKey.update({
    where: { id: apiKeyRecord.id },
    data: { lastUsedAt: new Date() }
  }).catch(err => console.error('Failed to update lastUsedAt:', err))

  return {
    success: true,
    user: apiKeyRecord.user,
    apiKeyId: apiKeyRecord.id
  }
}
