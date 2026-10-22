import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Keypair } from '@stellar/stellar-sdk'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    collectiveWallet: { findUnique: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { decrypt } from '@/lib/crypto'

const actor = { id: 'user-1', email: 'creator@example.com' }

function makeRequest(body?: unknown, raw?: string): NextRequest {
  return new NextRequest('http://localhost/api/collective-wallets', {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  })
}

function createArgs() {
  return vi.mocked(prisma.collectiveWallet.create).mock.calls[0][0] as any
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(actor as any)
  vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'user-2' }, { id: 'user-3' }] as any)
  vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue(null)
  vi.mocked(prisma.collectiveWallet.create).mockImplementation(
    (async (args: any) => ({ id: 'wallet-1', name: args.data.name, stellarAddress: args.data.stellarAddress }) as any) as any
  )
})

describe('POST /api/collective-wallets', () => {
  it('creates a wallet with a generated keypair, enrolling the creator as a signer', async () => {
    const res = await POST(
      makeRequest({
        name: 'Team Treasury',
        threshold: 2,
        signers: [{ userId: 'user-2', weight: 2 }, { userId: 'user-3' }],
      })
    )

    expect(res.status).toBe(201)
    const data = createArgs().data
    expect(data.threshold).toBe(2)
    expect(data.signers.create).toEqual([
      { userId: 'user-1', weight: 1 },
      { userId: 'user-2', weight: 2 },
      { userId: 'user-3', weight: 1 },
    ])
    expect(Keypair.fromPublicKey(data.stellarAddress).publicKey()).toBe(data.stellarAddress)
    // Stored encrypted, decrypts to the secret for the generated address
    expect(data.encryptedSecretKey).not.toMatch(/^S/)
    expect(Keypair.fromSecret(decrypt(data.encryptedSecretKey)).publicKey()).toBe(data.stellarAddress)
  })

  it('never returns the secret key in the response', async () => {
    const res = await POST(makeRequest({ name: 'Solo', threshold: 1 }))
    expect(res.status).toBe(201)
    const text = await res.text()
    expect(text).not.toContain('encryptedSecretKey')
    expect(createArgs().select.encryptedSecretKey).toBeUndefined()
  })

  it('accepts a supplied secret key and encrypts it', async () => {
    const kp = Keypair.random()
    const res = await POST(
      makeRequest({ name: 'Imported', threshold: 1, stellarAddress: kp.publicKey(), secretKey: kp.secret() })
    )
    expect(res.status).toBe(201)
    const data = createArgs().data
    expect(data.stellarAddress).toBe(kp.publicKey())
    expect(data.encryptedSecretKey).not.toContain(kp.secret())
    expect(decrypt(data.encryptedSecretKey)).toBe(kp.secret())
  })

  it('accepts an address-only wallet without storing a secret', async () => {
    const address = Keypair.random().publicKey()
    const res = await POST(makeRequest({ name: 'External', threshold: 1, stellarAddress: address }))
    expect(res.status).toBe(201)
    expect(createArgs().data.encryptedSecretKey).toBeNull()
  })

  it('uses the creator weight when the creator lists themselves', async () => {
    await POST(makeRequest({ name: 'W', threshold: 1, signers: [{ userId: 'user-1', weight: 5 }] }))
    expect(createArgs().data.signers.create).toEqual([{ userId: 'user-1', weight: 5 }])
  })

  it.each([0, -1])('rejects threshold %i', async (threshold) => {
    const res = await POST(makeRequest({ name: 'W', threshold }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('threshold must be between 1')
    expect(prisma.collectiveWallet.create).not.toHaveBeenCalled()
  })

  it('rejects threshold above the number of initial signers', async () => {
    const res = await POST(makeRequest({ name: 'W', threshold: 3, signers: [{ userId: 'user-2' }] }))
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.details).toEqual({ threshold: 3, signerCount: 2 })
  })

  it('rejects a non-integer threshold', async () => {
    const res = await POST(makeRequest({ name: 'W', threshold: 1.5 }))
    expect(res.status).toBe(400)
    expect((await res.json()).details.threshold).toBeDefined()
  })

  it('rejects duplicate signers in the request', async () => {
    const res = await POST(
      makeRequest({ name: 'W', threshold: 1, signers: [{ userId: 'user-2' }, { userId: 'user-2' }] })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Duplicate signer')
  })

  it('rejects signers that do not exist', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'user-2' }] as any)
    const res = await POST(
      makeRequest({ name: 'W', threshold: 1, signers: [{ userId: 'user-2' }, { userId: 'ghost' }] })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).details.missingUserIds).toEqual(['ghost'])
  })

  it('rejects an invalid Stellar address', async () => {
    const res = await POST(makeRequest({ name: 'W', threshold: 1, stellarAddress: 'GNOTVALID' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Invalid Stellar address')
  })

  it('rejects a secret key that does not match the address', async () => {
    const res = await POST(
      makeRequest({
        name: 'W',
        threshold: 1,
        stellarAddress: Keypair.random().publicKey(),
        secretKey: Keypair.random().secret(),
      })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('secretKey does not match stellarAddress')
  })

  it('rejects an invalid secret key', async () => {
    const res = await POST(makeRequest({ name: 'W', threshold: 1, secretKey: 'SNOTASECRET' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid Stellar secret key')
  })

  it('returns 409 when the Stellar address is already used', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({ id: 'other' } as any)
    const res = await POST(
      makeRequest({ name: 'W', threshold: 1, stellarAddress: Keypair.random().publicKey() })
    )
    expect(res.status).toBe(409)
    expect(prisma.collectiveWallet.create).not.toHaveBeenCalled()
  })

  it('returns 409 when a concurrent create wins the unique constraint', async () => {
    vi.mocked(prisma.collectiveWallet.create).mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    )
    const res = await POST(makeRequest({ name: 'W', threshold: 1 }))
    expect(res.status).toBe(409)
  })

  it('returns 400 for a missing name', async () => {
    const res = await POST(makeRequest({ threshold: 1 }))
    expect(res.status).toBe(400)
    expect((await res.json()).details.name).toBeDefined()
  })

  it('returns 400 for invalid JSON', async () => {
    const res = await POST(makeRequest(undefined, 'not json'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid JSON body')
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    const res = await POST(makeRequest({ name: 'W', threshold: 1 }))
    expect(res.status).toBe(401)
    expect(prisma.collectiveWallet.create).not.toHaveBeenCalled()
  })

  it('returns 404 when the authenticated user has no account', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await POST(makeRequest({ name: 'W', threshold: 1 }))
    expect(res.status).toBe(404)
  })

  it('returns 500 on unexpected errors', async () => {
    vi.mocked(prisma.collectiveWallet.create).mockRejectedValue(new Error('db down'))
    const res = await POST(makeRequest({ name: 'W', threshold: 1 }))
    expect(res.status).toBe(500)
  })
})
