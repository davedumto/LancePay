import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import type { Account } from '@stellar/stellar-sdk'
import type { AnchorConfig } from '@/lib/anchors'
import { clearSep10TokenCache, getSep10Token } from '@/lib/sep10'

const SERVER_KEYPAIR = Keypair.random()
const WRONG_KEYPAIR = Keypair.random()
const CLIENT_KEYPAIR = Keypair.random()

const PASSPHRASE = Networks.PUBLIC

const ANCHOR_CONFIG: AnchorConfig = {
  id: 'moneygram',
  name: 'MoneyGram',
  homeDomain: 'stellar.moneygram.com',
  sep24Endpoint: 'https://sep24.example.com',
  webAuthEndpoint: 'https://auth.example.com/sep10',
  signingKey: SERVER_KEYPAIR.publicKey(),
}

/** Minimal account-like source for TransactionBuilder (sequence -1 → tx seq 0). */
function fakeAccount(publicKey: string, sequence = '-1'): Account {
  return {
    sequenceNumber: () => sequence,
    incrementSequenceNumber: () => undefined,
    accountId: () => publicKey,
  } as unknown as Account
}

function buildChallenge(signWith: Keypair, sequence = '-1'): string {
  const tx = new TransactionBuilder(fakeAccount(signWith.publicKey(), sequence), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.manageData({
        name: 'stellar.moneygram.com auth',
        value: 'a'.repeat(64),
      }),
    )
    .setTimeout(300)
    .build()
  tx.sign(signWith)
  return tx.toXDR()
}

function makeJwt(expSeconds: number): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'EdDSA' })}.${encode({
    iss: 'https://auth.example.com',
    sub: `${CLIENT_KEYPAIR.publicKey()}:12345`,
    iat: Math.floor(Date.now() / 1000),
    exp: expSeconds,
  })}.c2ln`
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockAnchor(token: string, challengeXdr?: string) {
  vi.mocked(fetch).mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') {
      return jsonResponse({ token })
    }
    return jsonResponse({
      transaction: challengeXdr ?? buildChallenge(SERVER_KEYPAIR),
      network_passphrase: PASSPHRASE,
    })
  })
}

function fetchCalls() {
  return vi.mocked(fetch).mock.calls
}

describe('getSep10Token', () => {
  beforeEach(() => {
    clearSep10TokenCache()
    vi.stubEnv('STELLAR_FUNDING_WALLET_SECRET', CLIENT_KEYPAIR.secret())
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('fetches a challenge, signs it, and exchanges it for a JWT', async () => {
    const jwt = makeJwt(Math.floor(Date.now() / 1000) + 3600)
    mockAnchor(jwt)

    const token = await getSep10Token(ANCHOR_CONFIG, 'user-42')

    expect(token).toBe(jwt)

    const [getUrl, getInit] = fetchCalls()[0]
    expect(String(getUrl)).toContain(ANCHOR_CONFIG.webAuthEndpoint)
    expect(String(getUrl)).toContain('account=')
    // The account id is memoized into a uint64 SEP-10 memo.
    expect(String(getUrl)).toContain('memo=')
    expect(getInit?.method).toBeUndefined()

    const [postUrl, postInit] = fetchCalls()[1]
    expect(String(postUrl)).toBe(ANCHOR_CONFIG.webAuthEndpoint)
    expect(postInit?.method).toBe('POST')

    const body = JSON.parse(String(postInit?.body)) as { transaction: string }
    const signed = new Transaction(body.transaction, PASSPHRASE)
    // Server signature + client (funding wallet) signature.
    expect(signed.signatures).toHaveLength(2)
    const clientSig = signed.signatures.find((s) =>
      CLIENT_KEYPAIR.verify(signed.hash(), s.signature()),
    )
    expect(clientSig).toBeDefined()
  })

  it('caches the JWT per anchor and account until expiry', async () => {
    const jwt = makeJwt(Math.floor(Date.now() / 1000) + 3600)
    mockAnchor(jwt)

    await getSep10Token(ANCHOR_CONFIG, 'user-1')
    await getSep10Token(ANCHOR_CONFIG, 'user-1')
    // A different account gets its own challenge/token exchange.
    await getSep10Token(ANCHOR_CONFIG, 'user-2')

    // 2 fetches for user-1 (GET+POST), 2 for user-2 — the repeat was cached.
    expect(fetchCalls()).toHaveLength(4)
  })

  it('rejects a challenge signed by the wrong key', async () => {
    mockAnchor('unused', buildChallenge(WRONG_KEYPAIR))

    await expect(getSep10Token(ANCHOR_CONFIG, 'user-1')).rejects.toThrow(
      /not signed by the anchor signing key/,
    )
  })

  it('rejects a challenge with a non-zero sequence number', async () => {
    mockAnchor('unused', buildChallenge(SERVER_KEYPAIR, '41'))

    await expect(getSep10Token(ANCHOR_CONFIG, 'user-1')).rejects.toThrow(
      /sequence number 0/,
    )
  })

  it('refreshes an expired JWT instead of serving it from cache', async () => {
    const expiredJwt = makeJwt(Math.floor(Date.now() / 1000) - 60)
    const freshJwt = makeJwt(Math.floor(Date.now() / 1000) + 3600)
    let token = expiredJwt
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') {
        return jsonResponse({ token })
      }
      return jsonResponse({
        transaction: buildChallenge(SERVER_KEYPAIR),
        network_passphrase: PASSPHRASE,
      })
    })

    expect(await getSep10Token(ANCHOR_CONFIG, 'user-1')).toBe(expiredJwt)
    token = freshJwt
    expect(await getSep10Token(ANCHOR_CONFIG, 'user-1')).toBe(freshJwt)
    // Both calls performed a full challenge + exchange round trip.
    expect(fetchCalls()).toHaveLength(4)
  })

  it('does not cache tokens without an exp claim', async () => {
    const noExpJwt = `${Buffer.from('{"alg":"EdDSA"}').toString('base64url')}.${Buffer.from('{"sub":"G"}').toString('base64url')}.sig`
    mockAnchor(noExpJwt)

    await getSep10Token(ANCHOR_CONFIG, 'user-1')
    await getSep10Token(ANCHOR_CONFIG, 'user-1')

    expect(fetchCalls()).toHaveLength(4)
  })

  it('fails when the funding wallet secret is not configured', async () => {
    vi.stubEnv('STELLAR_FUNDING_WALLET_SECRET', '')
    vi.stubEnv('STELLAR_FUNDING_SECRET', '')
    mockAnchor('unused')

    await expect(getSep10Token(ANCHOR_CONFIG, 'user-1')).rejects.toThrow(
      /STELLAR_FUNDING_WALLET_SECRET/,
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('propagates challenge endpoint failures', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'rate limited' }, 429))

    await expect(getSep10Token(ANCHOR_CONFIG, 'user-1')).rejects.toThrow(
      /challenge request failed with status 429/,
    )
  })
})
