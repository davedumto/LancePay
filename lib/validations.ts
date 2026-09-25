import { z } from 'zod'
import { SUPPORTED_INVOICE_CURRENCIES } from '@/lib/invoice-currency'

export const createInvoiceSchema = z.object({
  clientEmail: z.string().email(),
  clientName: z.string().nullish(),
  description: z.string().min(1).max(500),
  amount: z.number().finite().positive().max(100000),
  currency: z.enum(SUPPORTED_INVOICE_CURRENCIES).optional().default('USD'),
  dueDate: z
    .string()
    .optional()
    .refine((val) => !val || !isNaN(new Date(val).getTime()), 'Invalid date format'),
})

export const addBankAccountSchema = z.object({
  bankCode: z.string().regex(/^\d{3}$/, 'Bank code must be 3 digits'),
  accountNumber: z.string().regex(/^\d{10}$/, 'Account number must be 10 digits'),
})

export const createApiKeySchema = z.object({
  name: z.string()
    .min(1, 'Name is required')
    .max(100, 'Name must be less than 100 characters')
    .regex(/^[a-zA-Z0-9\s\-_]+$/, 'Name can only contain letters, numbers, spaces, hyphens, and underscores')
})

export const externalInvoiceSchema = z.object({
  clientEmail: z.string().email('Invalid email address'),
  clientName: z.string().max(255).optional(),
  description: z.string().min(3, 'Description must be at least 3 characters').max(500, 'Description too long'),
  amount: z.number().positive('Amount must be positive').max(100000, 'Amount exceeds maximum'),
  currency: z.string().optional().default('USD'),
  dueDate: z.string()
    .optional()
    .refine(
      (val) => !val || !isNaN(new Date(val).getTime()),
      'Invalid date format'
    )
    .refine(
      (val) => !val || new Date(val).getTime() > Date.now(),
      'Due date must be in the future'
    )
})

export const createSubscriptionSchema = z.object({
  clientEmail: z.string().email(),
  clientName: z.string().optional(),
  description: z.string().min(1).max(500),
  amount: z.number().positive().max(100000),
  currency: z.string().optional().default('USD'),
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']).optional().default('monthly'),
  interval: z.number().int().positive().optional().default(1),
  startDate: z.string().optional(),
})

export const createWhitelistAddressSchema = z.object({
  label: z.string().min(1, 'Label is required').max(100, 'Label must be less than 100 characters'),
  address: z.string().min(1, 'Address is required').max(70, 'Address is too long'),
  network: z.enum(['stellar', 'bank'], { errorMap: () => ({ message: 'Network must be "stellar" or "bank"' }) }),
})

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>
export type AddBankAccountInput = z.infer<typeof addBankAccountSchema>
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>
export type ExternalInvoiceInput = z.infer<typeof externalInvoiceSchema>
export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>
export type CreateWhitelistAddressInput = z.infer<typeof createWhitelistAddressSchema>
