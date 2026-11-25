/**
 * Anchor configuration for SEP-24 interactive withdrawals.
 * Supported anchors: MoneyGram and Yellowcard
 *
 * Per SEP-1, each anchor publishes TRANSFER_SERVER_SEP0024, WEB_AUTH_ENDPOINT
 * and SIGNING_KEY in the stellar.toml hosted on its home domain. Those values
 * can change without notice, so they are discovered from the TOML at runtime
 * (with a TTL cache) instead of being hardcoded. Environment variables act as
 * per-field overrides for testing and emergencies; when the TOML cannot be
 * fetched and no override is set for a required field, resolution fails closed.
 */

export const SUPPORTED_ANCHORS = ['moneygram', 'yellowcard'] as const

export type AnchorId = typeof SUPPORTED_ANCHORS[number]

/**
 * Type guard to validate if a string is a supported anchor ID.
 */
export function isSupportedAnchor(id: string): id is AnchorId {
  return SUPPORTED_ANCHORS.includes(id as AnchorId)
}

interface AnchorDefinition {
  id: AnchorId
  name: string
  /** Domain hosting the anchor's stellar.toml (SEP-1 discovery). */
  homeDomain: string
  /** Prefix for per-anchor env overrides, e.g. MONEYGRAM_SEP24_ENDPOINT. */
  envPrefix: string
}

const ANCHOR_DEFINITIONS: Record<AnchorId, AnchorDefinition> = {
  moneygram: {
    id: 'moneygram',
    name: 'MoneyGram',
    homeDomain: 'stellar.moneygram.com',
    envPrefix: 'MONEYGRAM',
  },
  yellowcard: {
    id: 'yellowcard',
    name: 'YellowCard',
    homeDomain: 'yellowcard.io',
    envPrefix: 'YELLOWCARD',
  },
}

/** SEP-1 stellar.toml keys consumed by the anchor integration. */
const TOML_FIELDS = [
  'TRANSFER_SERVER_SEP0024',
  'WEB_AUTH_ENDPOINT',
  'SIGNING_KEY',
] as const

const DEFAULT_TOML_CACHE_TTL_MS = 5 * 60 * 1000

interface TomlCacheEntry {
  fields: Record<string, string>
  expiresAt: number
}

const tomlCache = new Map<string, TomlCacheEntry>()

/**
 * Clear the stellar.toml cache. Intended for tests.
 */
export function clearAnchorTomlCache(): void {
  tomlCache.clear()
}

function tomlCacheTtlMs(): number {
  const raw = process.env.ANCHOR_TOML_CACHE_TTL_MS
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOML_CACHE_TTL_MS
}

/**
 * Parse the top-level key/value pairs of a SEP-1 stellar.toml document.
 * Only keys declared before the first `[section]` header are returned — the
 * SEP-1 discovery fields (TRANSFER_SERVER_SEP0024, WEB_AUTH_ENDPOINT,
 * SIGNING_KEY) are always top-level.
 */
export function parseStellarToml(toml: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of toml.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) break
    const match = /^([A-Za-z0-9_]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(trimmed)
    if (match) {
      fields[match[1]] = match[2].replace(/\\(.)/g, '$1')
    }
  }
  return fields
}

/**
 * Fetch and parse the anchor's stellar.toml, caching the result for the
 * configured TTL. Tries the well-known path first, then the root path, since
 * anchors host the document at either location.
 */
async function fetchAnchorToml(homeDomain: string): Promise<Record<string, string>> {
  const cached = tomlCache.get(homeDomain)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.fields
  }

  const candidates = [
    `https://${homeDomain}/.well-known/stellar.toml`,
    `https://${homeDomain}/stellar.toml`,
  ]

  let lastError: unknown = new Error(`No stellar.toml candidates for ${homeDomain}`)
  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/toml, text/plain, */*' },
      })
      if (!response.ok) {
        lastError = new Error(`stellar.toml request to ${url} returned ${response.status}`)
        continue
      }
      const fields = parseStellarToml(await response.text())
      if (TOML_FIELDS.some((key) => fields[key])) {
        tomlCache.set(homeDomain, {
          fields,
          expiresAt: Date.now() + tomlCacheTtlMs(),
        })
        return fields
      }
      lastError = new Error(`stellar.toml at ${url} contained no SEP-1 anchor fields`)
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to fetch stellar.toml for ${homeDomain}`)
}

/**
 * Get anchor configuration by ID, resolving SEP-24/SEP-10 endpoints from the
 * anchor's stellar.toml unless overridden by environment variables.
 * Returns null if anchor is not supported.
 * Throws when a required field cannot be resolved (fail closed).
 */
export async function getAnchorConfig(anchorId: AnchorId): Promise<AnchorConfig | null> {
  const definition = ANCHOR_DEFINITIONS[anchorId]
  if (!definition) {
    return null
  }

  const env = (suffix: string): string | undefined =>
    process.env[`${definition.envPrefix}_${suffix}`]?.trim() || undefined

  const homeDomain = env('HOME_DOMAIN') || definition.homeDomain

  const sep24Endpoint = env('SEP24_ENDPOINT')
  const webAuthEndpoint = env('WEB_AUTH_ENDPOINT')
  const signingKey = env('SIGNING_KEY')

  // Skip discovery entirely when every required field is overridden.
  let tomlFields: Record<string, string> = {}
  if (!(sep24Endpoint && webAuthEndpoint && signingKey)) {
    tomlFields = await fetchAnchorToml(homeDomain)
  }

  const resolved = {
    sep24Endpoint: sep24Endpoint || tomlFields.TRANSFER_SERVER_SEP0024,
    webAuthEndpoint: webAuthEndpoint || tomlFields.WEB_AUTH_ENDPOINT,
    signingKey: signingKey || tomlFields.SIGNING_KEY,
  }

  const missing = (
    ['sep24Endpoint', 'webAuthEndpoint', 'signingKey'] as const
  ).filter((key) => !resolved[key])

  if (missing.length > 0) {
    throw new Error(
      `Anchor configuration for "${anchorId}" is incomplete: missing ${missing.join(', ')}. ` +
        `Set ${definition.envPrefix}_SEP24_ENDPOINT, ${definition.envPrefix}_WEB_AUTH_ENDPOINT ` +
        `and ${definition.envPrefix}_SIGNING_KEY, or ensure ` +
        `https://${homeDomain}/.well-known/stellar.toml is reachable.`,
    )
  }

  return {
    id: definition.id,
    name: definition.name,
    homeDomain,
    sep24Endpoint: resolved.sep24Endpoint as string,
    webAuthEndpoint: resolved.webAuthEndpoint as string,
    signingKey: resolved.signingKey as string,
    clientId: env('CLIENT_ID'),
    clientSecret: env('CLIENT_SECRET'),
  }
}

export interface AnchorConfig {
  id: AnchorId
  name: string
  /** Home domain used for SEP-1 stellar.toml discovery. */
  homeDomain: string
  /** SEP-24 transfer server base URL (TRANSFER_SERVER_SEP0024). */
  sep24Endpoint: string
  /** SEP-10 web authentication endpoint (WEB_AUTH_ENDPOINT). */
  webAuthEndpoint: string
  /** SEP-10 server signing key (SIGNING_KEY). */
  signingKey: string
  clientId?: string
  clientSecret?: string
}
