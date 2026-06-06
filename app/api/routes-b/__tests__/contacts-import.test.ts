import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseCsvText } from '../_lib/csv-import'
import { validateContact, parseTags, normalizeEmail } from '../_lib/contact-validation'

describe('CSV import', () => {
  describe('CSV parser', () => {
    it('parses simple CSV', async () => {
      const csv = `name,email,phone
John Doe,john@example.com,1234567890
Jane Smith,jane@example.com,0987654321`

      const rows = await parseCsvText(csv)
      expect(rows).toHaveLength(2)
      expect(rows[0].name).toBe('John Doe')
      expect(rows[0].email).toBe('john@example.com')
      expect(rows[1].name).toBe('Jane Smith')
    })

    it('handles quoted fields', async () => {
      const csv = `name,email
"John ""The Boss"" Doe",john@example.com
Jane Smith,jane@example.com`

      const rows = await parseCsvText(csv)
      expect(rows).toHaveLength(2)
      expect(rows[0].name).toBe('John "The Boss" Doe')
    })

    it('rejects missing required column', async () => {
      const csv = `email,phone
john@example.com,1234567890`

      await expect(parseCsvText(csv, { requiredColumns: ['name'] }))
        .rejects.toThrow('Missing required columns: name')
    })

    it('respects max rows', async () => {
      const csv = Array.from({ length: 150 }, (_, i) => `name,email\nPerson ${i},person${i}@example.com`).join('\n')

      await expect(parseCsvText(csv, { maxRows: 100 }))
        .rejects.toThrow('CSV exceeds maximum of 100 rows')
    })
  })

  describe('contact validation', () => {
    it('validates correct contact', () => {
      const result = validateContact({
        name: 'John Doe',
        email: 'john@example.com',
        phone: '1234567890',
        company: 'Acme Inc',
        tags: 'client;vip'
      }, 1)

      expect(result.ok).toBe(true)
      expect(result.data.name).toBe('John Doe')
      expect(result.data.email).toBe('john@example.com')
    })

    it('rejects missing name', () => {
      const result = validateContact({
        email: 'john@example.com'
      }, 1)

      expect(result.ok).toBe(false)
      expect(result.errors).toBeDefined()
    })

    it('rejects invalid email', () => {
      const result = validateContact({
        name: 'John Doe',
        email: 'not-an-email'
      }, 1)

      expect(result.ok).toBe(false)
    })

    it('accepts empty optional fields', () => {
      const result = validateContact({
        name: 'John Doe',
        email: '',
        phone: '',
        company: '',
        tags: ''
      }, 1)

      expect(result.ok).toBe(true)
    })
  })

  describe('tag parsing', () => {
    it('parses semicolon-separated tags', () => {
      expect(parseTags('client;vip;urgent')).toEqual(['client', 'vip', 'urgent'])
    })

    it('handles empty tags', () => {
      expect(parseTags('')).toEqual([])
      expect(parseTags(undefined)).toEqual([])
    })

    it('trims and filters empty tags', () => {
      expect(parseTags('client; ;vip;')).toEqual(['client', 'vip'])
    })
  })

  describe('email normalization', () => {
    it('normalizes email', () => {
      expect(normalizeEmail('John.Doe@Example.COM')).toBe('john.doe@example.com')
      expect(normalizeEmail('  john@example.com  ')).toBe('john@example.com')
    })

    it('returns null for empty email', () => {
      expect(normalizeEmail('')).toBe(null)
      expect(normalizeEmail(undefined)).toBe(null)
    })
  })
})