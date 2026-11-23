/**
 * Runtime database URL tuning for serverless (Vercel) + Neon.
 *
 * Every serverless instance opens its own connection pool, so under a traffic
 * burst a Prisma default pool (num_cpus * 2 + 1 connections per instance) can
 * exhaust Neon's direct connection limit. Runtime queries therefore use the
 * *pooled* Neon endpoint (PgBouncer, `-pooler` host) with a small per-instance
 * pool; migrations use the direct URL (`DIRECT_URL`, see prisma/schema.prisma).
 *
 * Parameters already present in `DATABASE_URL` always win, so an operator can
 * override anything from the environment without code changes.
 */

/** One connection per instance: PgBouncer multiplexes them across clients. */
export const DEFAULT_CONNECTION_LIMIT = 1
/** Seconds to wait for a free connection from the pool before failing. */
export const DEFAULT_POOL_TIMEOUT_SECONDS = 10
/** Seconds to wait for a new connection (covers Neon compute cold starts). */
export const DEFAULT_CONNECT_TIMEOUT_SECONDS = 15

type Env = Record<string, string | undefined>

function positiveInt(value: string | undefined, fallback: number): number {
  // Strict: parseInt would accept prefixes such as "1.5x" or "10abc".
  if (value === undefined || !/^\d+$/.test(value.trim())) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** Whether the host is a Neon pooled (PgBouncer) endpoint, e.g. `ep-abc-123-pooler.…neon.tech`. */
export function isNeonPooledHost(hostname: string): boolean {
  return /-pooler(\.|$)/.test(hostname)
}

/**
 * Returns `rawUrl` with serverless-friendly connection parameters added.
 *
 * - `connection_limit`, `pool_timeout`, `connect_timeout`: set from
 *   `DB_CONNECTION_LIMIT`, `DB_POOL_TIMEOUT` and `DB_CONNECT_TIMEOUT` (or the
 *   defaults above) unless the URL already specifies them.
 * - `pgbouncer=true`: added for Neon pooled hosts, which run PgBouncer in
 *   transaction mode and do not support prepared statements.
 *
 * Returns `undefined` for a missing URL and the input unchanged when it is not
 * a parseable URL, so a bad value surfaces as Prisma's own error at connect
 * time instead of crashing module import (and `next build`).
 */
export function buildDatabaseUrl(rawUrl: string | undefined, env: Env = process.env): string | undefined {
  if (!rawUrl) return undefined

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return rawUrl
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') return rawUrl

  const setDefault = (key: string, value: string) => {
    if (!url.searchParams.has(key)) url.searchParams.set(key, value)
  }

  setDefault('connection_limit', String(positiveInt(env.DB_CONNECTION_LIMIT, DEFAULT_CONNECTION_LIMIT)))
  setDefault('pool_timeout', String(positiveInt(env.DB_POOL_TIMEOUT, DEFAULT_POOL_TIMEOUT_SECONDS)))
  setDefault('connect_timeout', String(positiveInt(env.DB_CONNECT_TIMEOUT, DEFAULT_CONNECT_TIMEOUT_SECONDS)))
  if (isNeonPooledHost(url.hostname)) setDefault('pgbouncer', 'true')

  return url.toString()
}
