/**
 * Contact validation helper for CSV import.
 */

import { z } from 'zod'

export const contactSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().max(20).optional().or(z.literal('')),
  company: z.string().max(100).optional().or(z.literal('')),
  tags: z.string().optional().or(z.literal(''))
})

export type ContactInput = z.infer<typeof contactSchema>

export interface ValidationResult {
  row: number
  data: ContactInput
  ok: boolean
  errors?: string[]
}

export interface ImportResult {
  row: number
  ok: boolean
  contactId?: string
  error?: string
}

/**
 * Validate a single contact row.
 */
export function validateContact(row: any, rowNumber: number): ValidationResult {
  try {
    const parsed = contactSchema.parse(row)
    return {
      row: rowNumber,
      data: parsed,
      ok: true
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        row: rowNumber,
        data: row,
        ok: false,
        errors: error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
      }
    }
    return {
      row: rowNumber,
      data: row,
      ok: false,
      errors: ['Unknown validation error']
    }
  }
}

/**
 * Parse tags from semicolon-separated string.
 */
export function parseTags(tagString?: string): string[] {
  if (!tagString) return []
  return tagString
    .split(';')
    .map(tag => tag.trim())
    .filter(tag => tag.length > 0)
}

/**
 * Normalize email for deduplication.
 */
export function normalizeEmail(email?: string): string | null {
  if (!email) return null
  return email.trim().toLowerCase()
}