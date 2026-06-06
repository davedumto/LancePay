import { z } from 'zod'

export const DEFAULT_REMINDER_SETTINGS = {
  enabled: true,
  firstReminderDays: 3,
  secondReminderDays: 7,
  channel: 'email' as const,
  sendOnDueDate: true,
}

export const reminderSettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    firstReminderDays: z.number().int().min(1).max(30).optional(),
    secondReminderDays: z.number().int().min(1).max(60).optional(),
    channel: z.enum(['email', 'sms', 'push']).optional(),
    sendOnDueDate: z.boolean().optional(),
  })
  .strip()
  .superRefine((value, ctx) => {
    if (
      value.firstReminderDays !== undefined &&
      value.secondReminderDays !== undefined &&
      value.secondReminderDays <= value.firstReminderDays
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['secondReminderDays'],
        message: 'Must be greater than firstReminderDays',
      })
    }
  })

export type ReminderSettingsPatchPayload = z.infer<typeof reminderSettingsPatchSchema>
