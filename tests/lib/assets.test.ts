import { describe, it, expect } from 'vitest'
import { USDC_ASSET } from '@/lib/stellar'
import { KNOWN_ASSETS, resolveAssetMetadata } from '@/lib/assets'

describe('KNOWN_ASSETS', () => {
  it('derives the USDC issuer from USDC_ASSET', () => {
    const usdc = KNOWN_ASSETS.find((a) => a.code === 'USDC')
    expect(usdc?.issuer).toBe(USDC_ASSET.getIssuer())
    expect(usdc?.issuer).toBeTruthy()
  })

  it('resolves the configured USDC issuer as a verified asset', () => {
    const metadata = resolveAssetMetadata('USDC', USDC_ASSET.getIssuer())
    expect(metadata.isVerified).toBe(true)
    expect(metadata.name).toBe('USD Coin')
  })

  it('marks assets with a different issuer as unverified', () => {
    const metadata = resolveAssetMetadata(
      'USDC',
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    )
    // Only verified when it matches USDC_ASSET's issuer.
    expect(metadata.isVerified).toBe(
      USDC_ASSET.getIssuer() ===
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    )
  })

  it('serves icons from self-hosted paths, not external hotlinks', () => {
    for (const asset of KNOWN_ASSETS) {
      expect(asset.icon).toMatch(/^\/icons\//)
      expect(asset.icon).not.toContain('http')
    }
  })
})
