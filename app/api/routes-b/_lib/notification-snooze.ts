type SnoozeEntry = {
  until: number // Date.now() timestamp
}

const snoozeStore = new Map<string, SnoozeEntry>()

export function snoozeNotification(notificationId: string, until: Date): void {
  snoozeStore.set(notificationId, { until: until.getTime() })
}

export function unsnoozeNotification(notificationId: string): void {
  snoozeStore.delete(notificationId)
}

export function isNotificationSnoozed(notificationId: string, now = Date.now()): boolean {
  const entry = snoozeStore.get(notificationId)
  if (!entry) return false
  if (now >= entry.until) {
    snoozeStore.delete(notificationId)
    return false
  }
  return true
}

export function getSnoozedUntil(notificationId: string): Date | null {
  const entry = snoozeStore.get(notificationId)
  if (!entry) return null
  if (Date.now() >= entry.until) {
    snoozeStore.delete(notificationId)
    return null
  }
  return new Date(entry.until)
}

export function resetSnoozeStore(): void {
  snoozeStore.clear()
}
