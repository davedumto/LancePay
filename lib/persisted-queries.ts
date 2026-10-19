export interface PersistedQueryRecord {
  hash: string;
  appId: string;
  query: string;
  accessCount: number;
  createdAt: Date;
  lastAccessedAt: Date;
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

export function registerPersistedQuery(
  appId: string,
  hash: string,
  query: string,
): PersistedQueryRecord {
  const record: PersistedQueryRecord = {
    hash,
    appId,
    query,
    accessCount: 0,
    createdAt: new Date(),
    lastAccessedAt: new Date(),
  };
  PERSISTED_QUERY_STORE.set(`${appId}:${hash}`, record);
  return record;
}

export function getPersistedQuery(
  appId: string,
  hash: string,
): PersistedQueryRecord | undefined {
  return PERSISTED_QUERY_STORE.get(`${appId}:${hash}`);
}

export function resetPersistedQueryStore(): void {
  PERSISTED_QUERY_STORE.clear();
}
