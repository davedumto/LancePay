import { describe, it, expect } from 'vitest'
import { redactField, redactProfile, parseRevealQuery } from '../../_lib/redact'

describe('PII Redaction', () => {
  describe('redactField', () => {
    it('should return full value for full policy', () => {
      const result = redactField('test@example.com', 'full')
      expect(result).toBe('test@example.com')
    })

    it('should mask phone numbers showing last 4 digits', () => {
      const result = redactField('+1 (555) 123-4567', 'masked')
      expect(result).toBe('*******4567')
    })

    it('should mask short phone numbers', () => {
      const result = redactField('1234', 'masked')
      expect(result).toBe('1234')
    })

    it('should mask addresses showing city only', () => {
      const result = redactField('123 Main St, New York, NY 10001', 'masked')
      expect(result).toBe('NY 10001')
    })

    it('should mask short addresses', () => {
      const result = redactField('123 Main St', 'masked')
      expect(result).toBe('123***')
    })

    it('should mask general strings showing first 3 chars', () => {
      const result = redactField('generalstring', 'masked')
      expect(result).toBe('gen***')
    })

    it('should hide sensitive data', () => {
      const result = redactField('sensitive-data', 'hidden')
      expect(result).toBe('[REDACTED]')
    })

    it('should handle null and undefined values', () => {
      expect(redactField(null, 'masked')).toBeNull()
      expect(redactField(undefined, 'masked')).toBeNull()
    })

    it('should handle empty strings', () => {
      const result = redactField('', 'masked')
      expect(result).toBe('')
    })
  })

  describe('redactProfile', () => {
    const mockUser = {
      id: 'user-123',
      name: 'John Doe',
      email: 'john@example.com',
      phone: '+1 (555) 123-4567',
      address: '123 Main St, New York, NY 10001',
      governmentId: 'GOV123456',
      avatarUrl: 'https://example.com/avatar.jpg',
      taxPercentage: 0.1,
      timezone: 'America/New_York',
      role: 'freelancer',
      createdAt: '2023-01-01T00:00:00Z',
      updatedAt: '2023-01-01T00:00:00Z',
    }

    it('should apply default masked policy for non-admins', () => {
      const result = redactProfile(mockUser)
      
      expect(result.id).toBe('user-123')
      expect(result.name).toBe('John Doe')
      expect(result.email).toBe('joh***')
      expect(result.phone).toBe('*******4567')
      expect(result.address).toBe('NY 10001')
      expect(result.governmentId).toBe('[REDACTED]')
      expect(result.avatarUrl).toBe('https://example.com/avatar.jpg')
    })

    it('should apply full policy for admins', () => {
      const result = redactProfile(mockUser, { isAdmin: true })
      
      expect(result.id).toBe('user-123')
      expect(result.name).toBe('John Doe')
      expect(result.email).toBe('john@example.com')
      expect(result.phone).toBe('+1 (555) 123-4567')
      expect(result.address).toBe('123 Main St, New York, NY 10001')
      expect(result.governmentId).toBe('[REDACTED]') // Always hidden
    })

    it('should reveal specified fields for admins', () => {
      const result = redactProfile(mockUser, {
        isAdmin: true,
        revealFields: ['phone', 'address']
      })
      
      expect(result.phone).toBe('+1 (555) 123-4567')
      expect(result.address).toBe('123 Main St, New York, NY 10001')
      expect(result.email).toBe('john@example.com') // Admin gets full access
    })

    it('should not reveal fields for non-admins even with revealFields', () => {
      const result = redactProfile(mockUser, {
        isAdmin: false,
        revealFields: ['phone', 'address']
      })
      
      expect(result.phone).toBe('*******4567') // Still masked
      expect(result.address).toBe('NY 10001') // Still masked
    })

    it('should handle empty user data', () => {
      const result = redactProfile({})
      expect(result).toEqual({})
    })

    it('should handle null user data', () => {
      const result = redactProfile(null)
      expect(result).toEqual({})
    })
  })

  describe('parseRevealQuery', () => {
    it('should parse comma-separated field names', () => {
      const searchParams = new URLSearchParams('reveal=phone,address,email')
      const result = parseRevealQuery(searchParams)
      expect(result).toEqual(['phone', 'address', 'email'])
    })

    it('should handle empty reveal parameter', () => {
      const searchParams = new URLSearchParams('reveal=')
      const result = parseRevealQuery(searchParams)
      expect(result).toEqual([])
    })

    it('should handle missing reveal parameter', () => {
      const searchParams = new URLSearchParams('other=value')
      const result = parseRevealQuery(searchParams)
      expect(result).toEqual([])
    })

    it('should trim whitespace from field names', () => {
      const searchParams = new URLSearchParams('reveal= phone , address , email ')
      const result = parseRevealQuery(searchParams)
      expect(result).toEqual(['phone', 'address', 'email'])
    })

    it('should filter out empty field names', () => {
      const searchParams = new URLSearchParams('reveal=phone,,address,,')
      const result = parseRevealQuery(searchParams)
      expect(result).toEqual(['phone', 'address'])
    })
  })
})
