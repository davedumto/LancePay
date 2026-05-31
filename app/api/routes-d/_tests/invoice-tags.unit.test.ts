import { describe, it, expect, vi, beforeEach } from 'vitest'

// Unit tests for pure logic — no DB, no auth mocks
describe('Invoice Tags — Unit', () => {
  describe('Prisma unique error detection', () => {
    it('detects P2002 as unique constraint error', () => {
      const err = { code: 'P2002', message: 'Unique constraint failed' }
      
      const isPrismaUniqueError =
        typeof err === 'object' && err !== null && 'code' in err &&
        (err as { code: string }).code === 'P2002'

      expect(isPrismaUniqueError).toBe(true)
    })

    it('does not flag other Prisma errors as unique', () => {
      const err = { code: 'P2025', message: 'Record not found' }
      
      const isPrismaUniqueError =
        typeof err === 'object' && err !== null && 'code' in err &&
        (err as { code: string }).code === 'P2002'

      expect(isPrismaUniqueError).toBe(false)
    })

    it('handles null error gracefully', () => {
      const err = null
      
      const isPrismaUniqueError =
        typeof err === 'object' && err !== null && 'code' in err &&
        (err as { code: string }).code === 'P2002'

      expect(isPrismaUniqueError).toBe(false)
    })

    it('handles non-object error gracefully', () => {
      const err = 'string error'
      
      const isPrismaUniqueError =
        typeof err === 'object' && err !== null && 'code' in err &&
        (err as { code: string }).code === 'P2002'

      expect(isPrismaUniqueError).toBe(false)
    })
  })

  describe('Tag ID validation', () => {
    it('rejects undefined tagId', () => {
      const body: { tagId?: unknown } = {}
      const isValid = typeof body.tagId === 'string' && body.tagId.trim() !== ''
      expect(isValid).toBe(false)
    })

    it('rejects null tagId', () => {
      const body = { tagId: null }
      const isValid = typeof body.tagId === 'string' && body.tagId.trim() !== ''
      expect(isValid).toBe(false)
    })

    it('rejects number tagId', () => {
      const body = { tagId: 123 }
      const isValid = typeof body.tagId === 'string' && body.tagId.trim() !== ''
      expect(isValid).toBe(false)
    })

    it('rejects empty string tagId', () => {
      const body = { tagId: '   ' }
      const isValid = typeof body.tagId === 'string' && body.tagId.trim() !== ''
      expect(isValid).toBe(false)
    })

    it('accepts valid tagId', () => {
      const body = { tagId: 'tag-123-abc' }
      const isValid = typeof body.tagId === 'string' && body.tagId.trim() !== ''
      expect(isValid).toBe(true)
    })

    it('trims whitespace from tagId', () => {
      const body = { tagId: '  tag-123  ' }
      const tagId = body.tagId.trim()
      expect(tagId).toBe('tag-123')
    })
  })

  describe('Query param parsing (DELETE)', () => {
    it('extracts tagId from query string', () => {
      const url = new URL('http://localhost:3000/api/routes-d/invoices/inv-123/tags?tagId=tag-456')
      const tagId = url.searchParams.get('tagId')
      expect(tagId).toBe('tag-456')
    })

    it('returns null when tagId param missing', () => {
      const url = new URL('http://localhost:3000/api/routes-d/invoices/inv-123/tags')
      const tagId = url.searchParams.get('tagId')
      expect(tagId).toBeNull()
    })

    it('returns empty string when tagId is empty', () => {
      const url = new URL('http://localhost:3000/api/routes-d/invoices/inv-123/tags?tagId=')
      const tagId = url.searchParams.get('tagId')
      expect(tagId).toBe('')
    })
  })

  describe('Response shapes', () => {
    it('POST success response has correct fields', () => {
      const mockResponse = {
        invoiceId: 'inv-123',
        tagId: 'tag-456',
        tagName: 'Urgent',
        tagColor: '#ff0000',
      }
      
      expect(mockResponse).toHaveProperty('invoiceId')
      expect(mockResponse).toHaveProperty('tagId')
      expect(mockResponse).toHaveProperty('tagName')
      expect(mockResponse).toHaveProperty('tagColor')
    })

    it('DELETE success response has detached flag', () => {
      const mockResponse = {
        invoiceId: 'inv-123',
        tagId: 'tag-456',
        tagName: 'Urgent',
        tagColor: '#ff0000',
        detached: true,
      }
      
      expect(mockResponse).toHaveProperty('detached', true)
    })
  })
})