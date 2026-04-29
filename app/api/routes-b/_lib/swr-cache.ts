export type SwrEntry<T> = {
  value: T
  fetchedAt: number
  freshUntil: number
  staleUntil: number
}

const swrStore = ((globalThis as typeof globalThis & {
  __routesBSwrStore?: Map<string, SwrEntry<unknown>>
}).__routesBSwrStore ??= new Map<string, SwrEntry<unknown>>())

export function swrGet<T>(key: string): SwrEntry<T> | null {
  const entry = swrStore.get(key)
  if (!entry) return null
  if (Date.now() > entry.staleUntil) {
    swrStore.delete(key)
    return null
  }
  return entry as SwrEntry<T>
}

export function swrSet<T>(key: string, value: T, freshMs: number, staleMs: number): void {
  const now = Date.now()
  swrStore.set(key, {
    value,
    fetchedAt: now,
    freshUntil: now + freshMs,
    staleUntil: now + staleMs,
  })
}

export function swrDelete(key: string): void {
  swrStore.delete(key)
}

export function swrClear(): void {
  swrStore.clear()
}

export function swrIsFresh(entry: SwrEntry<unknown>): boolean {
  return Date.now() < entry.freshUntil
}

export function swrIsStale(entry: SwrEntry<unknown>): boolean {
  const now = Date.now()
  return now >= entry.freshUntil && now < entry.staleUntil
}
