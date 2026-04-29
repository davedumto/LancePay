import { z } from 'zod'

export const notificationPreferencesSchema = z.object({
  invoicePaid: z.boolean().optional(),
  invoiceOverdue: z.boolean().optional(),
  withdrawalCompleted: z.boolean().optional(),
  securityAlert: z.boolean().optional(),
  marketing: z.boolean().optional(),
})
