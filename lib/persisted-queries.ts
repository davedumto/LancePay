import crypto from 'crypto'

export interface PersistedQueryRecord {
  hash: string;
  appId: string;
  query: string;
  accessCount: number;
  createdAt: Date;
  lastAccessedAt: Date;
}

/**
 * Thrown when the supplied hash is not the SHA-256 of the normalized
 * query text — prevents a caller from binding a trusted-looking hash to
 * an arbitrary query.
 */
export class PersistedQueryHashMismatchError extends Error {
  readonly code = 'HASH_MISMATCH'
  constructor(
    public readonly expectedHash: string,
    public readonly computedHash: string,
  ) {
    super(
      `Persisted query hash mismatch: expected ${expectedHash}, computed ${computedHash}`,
    )
    this.name = 'PersistedQueryHashMismatchError'
  }
}

/**
 * Thrown when a hash is re-registered with different query text.
 */
export class PersistedQueryConflictError extends Error {
  readonly code = 'PERSISTED_QUERY_CONFLICT'
  constructor(public readonly hash: string) {
    super(`Persisted query ${hash} is already registered with different query text`)
    this.name = 'PersistedQueryConflictError'
  }
}

/**
 * Normalization rule for persisted query hashing: strip `#` comments
 * line-by-line, join lines with a space, collapse all whitespace runs to
 * a single space and trim. Clients must register the SHA-256 of this
 * normalized form — see computePersistedQueryHash.
 */
export function normalizePersistedQuery(query: string): string {
  const lines = query.split('\n')
  const withoutComments = lines
    .map((line) => {
      const commentIdx = line.indexOf('#')
      return commentIdx >= 0 ? line.slice(0, commentIdx) : line
    })
    .join(' ')
  return withoutComments.replace(/\s+/g, ' ').trim()
}

/** SHA-256 (hex) of the normalized query text. */
export function computePersistedQueryHash(query: string): string {
  return crypto
    .createHash('sha256')
    .update(normalizePersistedQuery(query), 'utf8')
    .digest('hex')
}

const globalPersistedStore = globalThis as typeof globalThis & {
  __lancepayPersistedQueries?: Map<string, PersistedQueryRecord>;
};

export const PERSISTED_QUERY_STORE =
  globalPersistedStore.__lancepayPersistedQueries ??
  new Map<string, PersistedQueryRecord>();

if (!globalPersistedStore.__lancepayPersistedQueries) {
  globalPersistedStore.__lancepayPersistedQueries = PERSISTED_QUERY_STORE;
}

function storeKey(appId: string, hash: string): string {
  return `${appId}:${hash}`;
}

/**
 * Registers a persisted query. The hash MUST equal the SHA-256 of the
 * normalized query text; mismatches throw PersistedQueryHashMismatchError.
 * Re-registering the same (appId, hash) with identical query text is
 * idempotent; different text throws PersistedQueryConflictError.
 */
export function registerPersistedQuery(
  appId: string,
  hash: string,
  query: string,
): PersistedQueryRecord {
  const computedHash = computePersistedQueryHash(query);
  if (hash.toLowerCase() !== computedHash.toLowerCase()) {
    throw new PersistedQueryHashMismatchError(hash, computedHash);
  }

  const key = storeKey(appId, hash);
  const existing = PERSISTED_QUERY_STORE.get(key);
  if (existing) {
    if (existing.query === query) return existing;
    throw new PersistedQueryConflictError(hash);
  }

  const now = new Date();
  const record: PersistedQueryRecord = {
    hash,
    appId,
    query,
    accessCount: 0,
    createdAt: now,
    lastAccessedAt: now,
  };
  PERSISTED_QUERY_STORE.set(key, record);
  return record;
}

/**
 * Looks up a persisted query scoped to a developer app. Every successful
 * lookup increments accessCount and refreshes lastAccessedAt so usage
 * metrics and stale-record pruning reflect real traffic.
 */
export function getPersistedQuery(
  appId: string,
  hash: string,
): PersistedQueryRecord | undefined {
  const record = PERSISTED_QUERY_STORE.get(storeKey(appId, hash));
  if (!record) return undefined;

  record.accessCount += 1;
  record.lastAccessedAt = new Date();
  return record;
}

/** Default retention window for pruning stale persisted queries: 30 days. */
export const PERSISTED_QUERY_RETENTION_MS =
  Number(process.env.PERSISTED_QUERY_RETENTION_MS) || 30 * 24 * 60 * 60 * 1000;

/**
 * Removes records whose lastAccessedAt is older than `maxAgeMs`
 * (defaults to PERSISTED_QUERY_RETENTION_MS). Returns the number of
 * records pruned.
 */
export function pruneStalePersistedQueries(
  maxAgeMs: number = PERSISTED_QUERY_RETENTION_MS,
  now: Date = new Date(),
): number {
  const cutoff = now.getTime() - maxAgeMs;
  let pruned = 0;
  for (const [key, record] of PERSISTED_QUERY_STORE) {
    if (record.lastAccessedAt.getTime() < cutoff) {
      PERSISTED_QUERY_STORE.delete(key);
      pruned += 1;
    }
  }
  return pruned;
}

export function resetPersistedQueryStore(): void {
  PERSISTED_QUERY_STORE.clear();
}
