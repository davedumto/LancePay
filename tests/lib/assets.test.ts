import { describe, it, expect, vi, beforeEach } from 'vitest'

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const IMPOSTOR_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

let resolveAssetMetadata: typeof import('@/lib/assets').resolveAssetMetadata

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_USDC_ISSUER', USDC_ISSUER)
  ;({ resolveAssetMetadata } = await import('@/lib/assets'))
})

describe('resolveAssetMetadata', () => {
  it('returns verified XLM metadata for the native asset code', () => {
    const meta = resolveAssetMetadata('XLM')
    expect(meta.name).toBe('Stellar Lumens')
    expect(meta.isVerified).toBe(true)
  })

  it('returns verified USDC metadata when code and issuer both match', () => {
    const meta = resolveAssetMetadata('USDC', USDC_ISSUER)
    expect(meta.name).toBe('USD Coin')
    expect(meta.isVerified).toBe(true)
    expect(meta.issuer).toBe(USDC_ISSUER)
  })

  it('returns an unverified entry for USDC with an impostor issuer', () => {
    const meta = resolveAssetMetadata('USDC', IMPOSTOR_ISSUER)
    expect(meta.isVerified).toBe(false)
    expect(meta.name).toBe('USDC')
    expect(meta.issuer).toBe(IMPOSTOR_ISSUER)
  })

  it('returns an unverified unknown entry for a non-native code without an issuer', () => {
    const meta = resolveAssetMetadata('USDC')
    expect(meta.isVerified).toBe(false)
    expect(meta.name).toBe('USDC')
    expect(meta.code).toBe('USDC')
  })

  it('does not leak XLM metadata for non-native codes missing an issuer', () => {
    const meta = resolveAssetMetadata('BTC')
    expect(meta.name).not.toBe('Stellar Lumens')
    expect(meta.isVerified).toBe(false)
  })

  it('returns an unverified fallback for unknown assets', () => {
    const meta = resolveAssetMetadata('DOGE', IMPOSTOR_ISSUER)
    expect(meta).toMatchObject({
      code: 'DOGE',
      issuer: IMPOSTOR_ISSUER,
      name: 'DOGE',
      isVerified: false,
    })
  })
})
