import { describe, it, expect } from 'vitest'
import {
  buildDatabaseUrl,
  isNeonPooledHost,
  DEFAULT_CONNECTION_LIMIT,
  DEFAULT_POOL_TIMEOUT_SECONDS,
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
} from '@/lib/db-url'

const POOLED = 'postgresql://user:pass@ep-cool-123-pooler.us-east-1.aws.neon.tech/lancepay?sslmode=require'
const DIRECT = 'postgresql://user:pass@ep-cool-123.us-east-1.aws.neon.tech/lancepay?sslmode=require'

function params(url: string | undefined) {
  return new URL(url as string).searchParams
}

describe('buildDatabaseUrl', () => {
  it('adds serverless pool settings and pgbouncer for a Neon pooled URL', () => {
    const p = params(buildDatabaseUrl(POOLED, {}))

    expect(p.get('connection_limit')).toBe(String(DEFAULT_CONNECTION_LIMIT))
    expect(p.get('pool_timeout')).toBe(String(DEFAULT_POOL_TIMEOUT_SECONDS))
    expect(p.get('connect_timeout')).toBe(String(DEFAULT_CONNECT_TIMEOUT_SECONDS))
    expect(p.get('pgbouncer')).toBe('true')
  })

  it('keeps existing query parameters such as sslmode', () => {
    expect(params(buildDatabaseUrl(POOLED, {})).get('sslmode')).toBe('require')
  })

  it('does not force pgbouncer on a direct (non-pooler) host', () => {
    const p = params(buildDatabaseUrl(DIRECT, {}))
    expect(p.has('pgbouncer')).toBe(false)
    expect(p.get('connection_limit')).toBe('1')
  })

  it('preserves credentials, host, path and database name', () => {
    const url = new URL(buildDatabaseUrl(POOLED, {}) as string)
    expect(url.username).toBe('user')
    expect(url.password).toBe('pass')
    expect(url.hostname).toBe('ep-cool-123-pooler.us-east-1.aws.neon.tech')
    expect(url.pathname).toBe('/lancepay')
  })

  it('never overrides parameters already present in the URL', () => {
    const explicit = `${POOLED}&connection_limit=5&pool_timeout=30&connect_timeout=60&pgbouncer=false`
    const p = params(buildDatabaseUrl(explicit, { DB_CONNECTION_LIMIT: '9' }))

    expect(p.get('connection_limit')).toBe('5')
    expect(p.get('pool_timeout')).toBe('30')
    expect(p.get('connect_timeout')).toBe('60')
    expect(p.get('pgbouncer')).toBe('false')
  })

  it('applies DB_* environment overrides', () => {
    const p = params(
      buildDatabaseUrl(POOLED, { DB_CONNECTION_LIMIT: '3', DB_POOL_TIMEOUT: '20', DB_CONNECT_TIMEOUT: '45' }),
    )

    expect(p.get('connection_limit')).toBe('3')
    expect(p.get('pool_timeout')).toBe('20')
    expect(p.get('connect_timeout')).toBe('45')
  })

  it.each(['abc', '0', '-2', '1.5x', ''])('falls back to defaults for invalid override %j', (bad) => {
    const p = params(buildDatabaseUrl(POOLED, { DB_CONNECTION_LIMIT: bad, DB_POOL_TIMEOUT: bad, DB_CONNECT_TIMEOUT: bad }))

    expect(p.get('connection_limit')).toBe('1')
    expect(p.get('pool_timeout')).toBe('10')
    expect(p.get('connect_timeout')).toBe('15')
  })

  it('accepts the postgres:// scheme as well', () => {
    const p = params(buildDatabaseUrl(POOLED.replace('postgresql://', 'postgres://'), {}))
    expect(p.get('connection_limit')).toBe('1')
  })

  it('is idempotent', () => {
    const once = buildDatabaseUrl(POOLED, {})
    expect(buildDatabaseUrl(once, {})).toBe(once)
  })

  it('returns undefined when the URL is missing or empty', () => {
    expect(buildDatabaseUrl(undefined, {})).toBeUndefined()
    expect(buildDatabaseUrl('', {})).toBeUndefined()
  })

  it('passes an unparseable URL through unchanged instead of throwing', () => {
    expect(buildDatabaseUrl('not a url', {})).toBe('not a url')
  })

  it('leaves non-PostgreSQL URLs untouched', () => {
    expect(buildDatabaseUrl('mysql://u:p@host/db', {})).toBe('mysql://u:p@host/db')
  })
})

describe('isNeonPooledHost', () => {
  it('detects the -pooler endpoint', () => {
    expect(isNeonPooledHost('ep-cool-123-pooler.us-east-1.aws.neon.tech')).toBe(true)
    expect(isNeonPooledHost('ep-cool-123.us-east-1.aws.neon.tech')).toBe(false)
    expect(isNeonPooledHost('localhost')).toBe(false)
    expect(isNeonPooledHost('my-pooler-db.example.com')).toBe(false)
  })
})
