import { NextRequest } from 'next/server'

export type RedactionPolicy = 'full' | 'masked' | 'hidden'

export interface PIIField {
  value: any
  policy: RedactionPolicy
}

export interface RedactionOptions {
  policy?: RedactionPolicy
  revealFields?: string[]
  isAdmin?: boolean
}

export function redactField(value: string | null | undefined, policy: RedactionPolicy): string | null {
  if (value === null || value === undefined) {
    return null
  }

  switch (policy) {
    case 'full':
      return value

    case 'masked':
      // For phone numbers: show last 4 digits
      if (/^\+?[\d\s\-\(\)]+$/.test(value)) {
        const digits = value.replace(/\D/g, '')
        if (digits.length >= 4) {
          const lastFour = digits.slice(-4)
          const maskLength = Math.max(0, digits.length - 4)
          return `*`.repeat(maskLength) + lastFour
        }
        return `*`.repeat(Math.min(value.length, 4))
      }
      
      // For addresses: show city only (basic implementation)
      if (value.includes(',') || value.length > 20) {
        const parts = value.split(',').map(part => part.trim())
        if (parts.length >= 2) {
          return parts[parts.length - 1] // Return last part (usually city/state)
        }
        return value.slice(0, 3) + '***'
      }
      
      // For other strings: show first 3 chars + ***
      if (value.length > 3) {
        return value.slice(0, 3) + '***'
      }
      return `*`.repeat(value.length)

    case 'hidden':
      return '[REDACTED]'

    default:
      return value
  }
}

export function redactProfile(data: any, options: RedactionOptions = {}): any {
  const { policy = 'masked', revealFields = [], isAdmin = false } = options

  // Default field policies for profile data
  const fieldPolicies: Record<string, RedactionPolicy> = {
    id: 'full',
    name: 'full',
    email: isAdmin ? 'full' : 'masked',
    phone: isAdmin ? 'full' : 'masked',
    address: isAdmin ? 'full' : 'hidden',
    governmentId: 'hidden', // Always hide government ID
    avatarUrl: 'full',
    taxPercentage: 'full',
    timezone: 'full',
    role: 'full',
    createdAt: 'full',
    updatedAt: 'full',
  }

  const result: any = {}

  for (const [key, value] of Object.entries(data || {})) {
    const fieldPolicy = fieldPolicies[key] || policy
    
    // Check if field should be revealed
    if (revealFields.includes(key) && isAdmin) {
      result[key] = value
    } else {
      result[key] = redactField(value as string | null | undefined, fieldPolicy)
    }
  }

  return result
}

export function parseRevealQuery(searchParams: URLSearchParams): string[] {
  const reveal = searchParams.get('reveal')
  if (!reveal) return []
  
  return reveal.split(',').map(field => field.trim()).filter(Boolean)
}

export function isAdminRequest(request: NextRequest): boolean {
  const adminHeader = request.headers.get('x-internal-admin')
  return adminHeader === 'true' || adminHeader === '1'
}
