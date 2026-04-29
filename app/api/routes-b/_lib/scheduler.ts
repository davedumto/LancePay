/**
 * Best-effort in-process invoice scheduler.
 *
 * LIMITATION: Scheduled state is held in-memory. It survives restarts only if
 * the `scheduledAt` field is persisted to the database (see invoice schedule route).
 * This dispatcher fires on each handler call — it is NOT a reliable cron worker.
 * For production reliability, use a dedicated cron job or queue.
 */

export interface ScheduledInvoice {
  invoiceId: string
  userId: string
  sendAt: Date
  cancelledAt?: Date
}

// invoiceId -> ScheduledInvoice
const schedules = new Map<string, ScheduledInvoice>()

// Callbacks registered by the schedule route
type SendCallback = (invoiceId: string, userId: string) => Promise<void>
const callbacks: SendCallback[] = []

export function registerSendCallback(cb: SendCallback) {
  callbacks.push(cb)
}

export function scheduleInvoice(invoiceId: string, userId: string, sendAt: Date): ScheduledInvoice {
  const entry: ScheduledInvoice = { invoiceId, userId, sendAt }
  schedules.set(invoiceId, entry)
  return entry
}

export function cancelSchedule(invoiceId: string): boolean {
  const entry = schedules.get(invoiceId)
  if (!entry || entry.cancelledAt) return false
  entry.cancelledAt = new Date()
  return true
}

export function getSchedule(invoiceId: string): ScheduledInvoice | null {
  return schedules.get(invoiceId) ?? null
}

/**
 * Tick: fire any due, non-cancelled schedules.
 * Call this at the top of any handler to get best-effort dispatch.
 */
export async function tickScheduler(now = new Date()) {
  for (const [invoiceId, entry] of schedules) {
    if (entry.cancelledAt) continue
    if (entry.sendAt <= now) {
      schedules.delete(invoiceId)
      for (const cb of callbacks) {
        try {
          await cb(invoiceId, entry.userId)
        } catch {
          // best-effort — swallow errors
        }
      }
    }
  }
}

/** For tests only */
export function clearSchedules() {
  schedules.clear()
}
