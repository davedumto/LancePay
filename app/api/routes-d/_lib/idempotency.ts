type StoredResponse = {
  bodyHash: string
  status: number
  body: unknown
  expiresAt: number
}

const store = new Map<string, StoredResponse>()

export function getIdempotentResponse(key: string): StoredResponse | null {
  const entry = store.get(key)
  if (!entry) {
    return null
  }

  if (entry.expiresAt <= Date.now()) {
    store.delete(key)
    return null
  }

  return entry
}

export function setIdempotentResponse(
  key: string,
  value: Omit<StoredResponse, 'expiresAt'>,
  ttlMs: number,
) {
  store.set(key, {
    ...value,
    expiresAt: Date.now() + ttlMs,
  })
}

/** Test helper — clears the in-memory idempotency store. */
export function clearIdempotencyStore(): void {
  store.clear()
}

export function buildWebhookPostIdempotencyKey(userId: string, idempotencyKey: string): string {
  return `routes-d:webhooks:${userId}:${idempotencyKey}`
}
