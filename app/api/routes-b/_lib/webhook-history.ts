type WebhookHistoryEntry = {
  eventId: string
  ts: string
  status: 'ok' | 'fail'
  latencyMs: number
  attempt: number
  bodyExcerpt: string
}

const historyStore = new Map<string, WebhookHistoryEntry[]>()
const MAX_HISTORY_SIZE = 100

export function recordWebhookDelivery(
  webhookId: string,
  entry: Omit<WebhookHistoryEntry, 'ts'>
) {
  const history = historyStore.get(webhookId) || []
  const newEntry: WebhookHistoryEntry = {
    ...entry,
    ts: new Date().toISOString()
  }

  history.unshift(newEntry) // Add to the beginning (newest first)

  if (history.length > MAX_HISTORY_SIZE) {
    history.pop() // Remove oldest
  }

  historyStore.set(webhookId, history)
}

export function getWebhookHistory(
  webhookId: string,
  statusFilter?: 'ok' | 'fail'
): WebhookHistoryEntry[] {
  const history = historyStore.get(webhookId) || []
  
  if (!statusFilter) {
    return history
  }

  return history.filter(entry => entry.status === statusFilter)
}

export function clearWebhookHistory(webhookId: string) {
  historyStore.delete(webhookId)
}
