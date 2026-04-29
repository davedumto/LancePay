type Suggestion = {
  type: 'invoice' | 'contact' | 'tag'
  id: string
  label: string
  matchedField: 'invoiceNumber' | 'clientName' | 'name'
}

type CacheEntry = {
  value: Suggestion[]
  expiresAt: number
}

const CACHE_TTL_MS = 30_000
const cache = new Map<string, CacheEntry>()

export function getSuggestCache(key: string, now = Date.now()): Suggestion[] | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (now >= hit.expiresAt) {
    cache.delete(key)
    return null
  }
  return hit.value
}

export function setSuggestCache(key: string, value: Suggestion[], now = Date.now()) {
  cache.set(key, {
    value,
    expiresAt: now + CACHE_TTL_MS,
  })
}

export function resetSuggestCache() {
  cache.clear()
}
