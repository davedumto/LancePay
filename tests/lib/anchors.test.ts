import { readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  clearAnchorTomlCache,
  getAnchorConfig,
  parseStellarToml,
} from '@/lib/anchors'

const FIXTURES = path.join(__dirname, '../fixtures/anchors')
const TOML_FIXTURE = readFileSync(
  path.join(FIXTURES, 'moneygram.stellar.toml'),
  'utf8',
)
const MISSING_FIELD_FIXTURE = readFileSync(
  path.join(FIXTURES, 'moneygram-missing-field.stellar.toml'),
  'utf8',
)

const TOML_URL = 'https://stellar.moneygram.com/.well-known/stellar.toml'
const TOML_FALLBACK_URL = 'https://stellar.moneygram.com/stellar.toml'

function tomlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/toml' },
  })
}

function lastFetchUrl(): string {
  const calls = vi.mocked(fetch).mock.calls
  return String(calls[calls.length - 1][0])
}

describe('parseStellarToml', () => {
  it('extracts top-level SEP-1 fields and ignores sections', () => {
    const fields = parseStellarToml(TOML_FIXTURE)
    expect(fields.SIGNING_KEY).toBe(
      'GD5NUMEX7LYHXGXCAD4PGW7JDMOUY2DKRGY5XZHJS5IONVHDKCJYGVCL',
    )
    expect(fields.WEB_AUTH_ENDPOINT).toBe(
      'https://stellar.moneygram.com/stellaradapterservice/auth',
    )
    expect(fields.TRANSFER_SERVER_SEP0024).toBe(
      'https://stellar.moneygram.com/stellaradapterservice/sep24',
    )
    // Keys inside [CURRENCIES] must not leak into the top-level map.
    expect(fields.code).toBeUndefined()
    expect(fields.issuer).toBeUndefined()
  })
})

describe('getAnchorConfig', () => {
  beforeEach(() => {
    clearAnchorTomlCache()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('resolves SEP-24/SEP-10 fields from the anchor stellar.toml', async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(tomlResponse(TOML_FIXTURE)))

    const config = await getAnchorConfig('moneygram')

    expect(config).toMatchObject({
      id: 'moneygram',
      name: 'MoneyGram',
      homeDomain: 'stellar.moneygram.com',
      sep24Endpoint: 'https://stellar.moneygram.com/stellaradapterservice/sep24',
      webAuthEndpoint:
        'https://stellar.moneygram.com/stellaradapterservice/auth',
      signingKey: 'GD5NUMEX7LYHXGXCAD4PGW7JDMOUY2DKRGY5XZHJS5IONVHDKCJYGVCL',
    })
    expect(lastFetchUrl()).toBe(TOML_URL)
  })

  it('falls back to the root stellar.toml path when well-known fails', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(tomlResponse('not found', 404))
      .mockResolvedValueOnce(tomlResponse(TOML_FIXTURE))

    const config = await getAnchorConfig('moneygram')

    expect(config?.sep24Endpoint).toContain('stellaradapterservice/sep24')
    expect(vi.mocked(fetch).mock.calls.map((c) => String(c[0]))).toEqual([
      TOML_URL,
      TOML_FALLBACK_URL,
    ])
  })

  it('serves repeated resolutions from the TTL cache', async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(tomlResponse(TOML_FIXTURE)))

    await getAnchorConfig('moneygram')
    await getAnchorConfig('moneygram')

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('refetches the stellar.toml after the TTL expires', async () => {
    vi.stubEnv('ANCHOR_TOML_CACHE_TTL_MS', '20')
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(tomlResponse(TOML_FIXTURE)))

    await getAnchorConfig('moneygram')
    await new Promise((resolve) => setTimeout(resolve, 30))
    await getAnchorConfig('moneygram')

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)
  })

  it('uses env overrides without fetching the stellar.toml', async () => {
    vi.stubEnv('MONEYGRAM_SEP24_ENDPOINT', 'https://sep24.example.com')
    vi.stubEnv('MONEYGRAM_WEB_AUTH_ENDPOINT', 'https://auth.example.com')
    vi.stubEnv('MONEYGRAM_SIGNING_KEY', 'GTEST')

    const config = await getAnchorConfig('moneygram')

    expect(config).toMatchObject({
      sep24Endpoint: 'https://sep24.example.com',
      webAuthEndpoint: 'https://auth.example.com',
      signingKey: 'GTEST',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('lets env overrides win over stellar.toml values', async () => {
    vi.stubEnv('MONEYGRAM_WEB_AUTH_ENDPOINT', 'https://auth.override.example.com')
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(tomlResponse(TOML_FIXTURE)))

    const config = await getAnchorConfig('moneygram')

    expect(config?.webAuthEndpoint).toBe('https://auth.override.example.com')
    expect(config?.sep24Endpoint).toBe(
      'https://stellar.moneygram.com/stellaradapterservice/sep24',
    )
  })

  it('fails closed when the TOML is missing a required field', async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(tomlResponse(MISSING_FIELD_FIXTURE)))

    await expect(getAnchorConfig('moneygram')).rejects.toThrow(
      /missing signingKey/,
    )
  })

  it('fails closed when the TOML cannot be fetched and no override is set', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'))

    await expect(getAnchorConfig('moneygram')).rejects.toThrow()
  })

  it('fails closed when every TOML URL returns an error page', async () => {
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(tomlResponse('<html>oops</html>', 200)),
    )

    await expect(getAnchorConfig('moneygram')).rejects.toThrow(
      /no SEP-1 anchor fields/,
    )
  })

  it('still fails closed on fetch failure when only some fields are overridden', async () => {
    vi.stubEnv('MONEYGRAM_SEP24_ENDPOINT', 'https://sep24.example.com')
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(tomlResponse('oops', 500)))

    await expect(getAnchorConfig('moneygram')).rejects.toThrow(
      /stellar\.toml/,
    )
  })
})
