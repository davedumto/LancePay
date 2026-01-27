import { z } from 'zod'

export const sendMessageSchema = z.object({
    invoiceId: z.string().uuid('Invalid invoice ID'),
    content: z.string().min(1, 'Message content is required').max(5000, 'Message too long'),
    attachmentUrl: z.string().url('Invalid attachment URL').optional(),
    senderName: z.string().min(1).max(100).optional(), // For guest clients
    isInternal: z.boolean().optional().default(false),
})

export type SendMessageInput = z.infer<typeof sendMessageSchema>
