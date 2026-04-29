const swrStore = globalThis.__routesBSwrStore ??= new Map()

function swrGet(key) {
  const entry = swrStore.get(key)
  if (!entry) return null
  if (Date.now() > entry.staleUntil) {
    swrStore.delete(key)
    return null
  }
  return entry
}

function swrSet(key, value, freshMs, staleMs) {
  const now = Date.now()
  swrStore.set(key, {
    value,
    fetchedAt: now,
    freshUntil: now + freshMs,
    staleUntil: now + staleMs,
  })
}

function swrDelete(key) {
  swrStore.delete(key)
}

function swrClear() {
  swrStore.clear()
}

function swrIsFresh(entry) {
  return Date.now() < entry.freshUntil
}

function swrIsStale(entry) {
  const now = Date.now()
  return now >= entry.freshUntil && now < entry.staleUntil
}

module.exports = {
  swrGet,
  swrSet,
  swrDelete,
  swrClear,
  swrIsFresh,
  swrIsStale,
}
