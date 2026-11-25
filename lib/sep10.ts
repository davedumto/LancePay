/**
 * SEP-10 (Stellar Web Authentication) client for anchor authentication.
 *
 * Flow:
 * 1. GET the anchor's WEB_AUTH_ENDPOINT with the client account (and an
 *    optional memo) to receive a challenge transaction signed by the anchor's
 *    SIGNING_KEY.
 * 2. Validate the challenge: it must have sequence number 0 (unexecutable on
 *    the network) and carry a valid signature from the anchor signing key.
 * 3. Sign the challenge with the platform funding keypair and POST it back to
 *    exchange it for a session JWT.
 * 4. Send the JWT as `Authorization: Bearer` to SEP-24 endpoints.
 *
 * JWTs are cached per anchor and account until shortly before they expire.
 */

import { createHash } from 'crypto'
import { Keypair, Networks, Transaction } from '@stellar/stellar-sdk'
import type { AnchorConfig } from './anchors'
import { FUNDING_SECRET_ENV, resolveFundingSecret } from './stellar-funding'

/** Refresh cached tokens this long before their `exp` claim. */
const TOKEN_EXPIRY_SKEW_MS = 30 * 1000

interface CachedToken {
  token: string
  expiresAtMs: number
}

const tokenCache = new Map<string, CachedToken>()

/**
 * Clear the SEP-10 token cache. Intended for tests.
 */
export function clearSep10TokenCache(): void {
  tokenCache.clear()
}

/**
 * Derive a deterministic uint64 memo from an arbitrary account identifier so
 * the SEP-10 `sub` claim (`G...:<memo>`) is scoped per account. SEP-10 memos
 * must be of type `id`, so non-numeric account ids are hashed into the
 * uint64 space.
 */
function accountMemoId(account: string): string {
  const digest = createHash('sha256').update(account, 'utf8').digest()
  // readBigUInt64BE always yields a value that fits a uint64 memo.
  return digest.readBigUInt64BE(0).toString()
}

function decodeJwtExpiryMs(token: string): number | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as { exp?: unknown }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

function networkPassphrase(responsePassphrase?: string): string {
  if (responsePassphrase) return responsePassphrase
  return process.env.NEXT_PUBLIC_STELLAR_NETWORK === 'mainnet'
    ? Networks.PUBLIC
    : Networks.TESTNET
}

/**
 * Validate a SEP-10 challenge transaction:
 * - sequence number must be 0 so it can never execute on the network
 * - it must carry a valid signature from the anchor's SIGNING_KEY
 */
function assertValidChallenge(
  challengeXdr: string,
  passphrase: string,
  signingKey: string,
): Transaction {
  let transaction: Transaction
  try {
    transaction = new Transaction(challengeXdr, passphrase)
  } catch {
    throw new Error('SEP-10 challenge is not a valid Stellar transaction')
  }

  if (transaction.sequence !== '0') {
    throw new Error(
      `SEP-10 challenge rejected: expected sequence number 0, got ${transaction.sequence}`,
    )
  }

  const serverKeypair = Keypair.fromPublicKey(signingKey)
  const verified = transaction.signatures.some((signature) =>
    serverKeypair.verify(transaction.hash(), signature.signature()),
  )
  if (!verified) {
    throw new Error(
      'SEP-10 challenge rejected: transaction is not signed by the anchor signing key',
    )
  }

  return transaction
}

/**
 * Obtain a SEP-10 session JWT for an anchor, cached per anchor + account
 * until just before expiry.
 *
 * @param config Resolved anchor configuration (webAuthEndpoint, signingKey)
 * @param account Optional anchor-side account identifier; when provided it is
 *   encoded as a memo so the JWT `sub` is scoped to that account.
 * @returns The bearer JWT to send to SEP-24 endpoints
 * @throws Error when the funding keypair is missing, the challenge is invalid,
 *   or the token exchange fails
 */
export async function getSep10Token(
  config: AnchorConfig,
  account?: string,
): Promise<string> {
  const cacheKey = `${config.id}:${account ?? ''}`
  const cached = tokenCache.get(cacheKey)
  if (cached && cached.expiresAtMs - TOKEN_EXPIRY_SKEW_MS > Date.now()) {
    return cached.token
  }

  const fundingSecret = resolveFundingSecret()
  if (!fundingSecret) {
    throw new Error(
      `SEP-10 authentication requires ${FUNDING_SECRET_ENV} (or its deprecated alias) to be configured`,
    )
  }
  const clientKeypair = Keypair.fromSecret(fundingSecret)

  const challengeUrl = new URL(config.webAuthEndpoint)
  challengeUrl.searchParams.set('account', clientKeypair.publicKey())
  if (account) {
    challengeUrl.searchParams.set('memo', accountMemoId(account))
  }

  const challengeResponse = await fetch(challengeUrl.toString(), {
    headers: { Accept: 'application/json' },
  })
  if (!challengeResponse.ok) {
    throw new Error(
      `SEP-10 challenge request failed with status ${challengeResponse.status}`,
    )
  }

  const challenge = (await challengeResponse.json()) as {
    transaction?: string
    network_passphrase?: string
  }
  if (!challenge.transaction) {
    throw new Error('SEP-10 challenge response missing transaction')
  }

  const passphrase = networkPassphrase(challenge.network_passphrase)
  const transaction = assertValidChallenge(
    challenge.transaction,
    passphrase,
    config.signingKey,
  )

  // Prove control of the client account by signing the challenge.
  transaction.sign(clientKeypair)

  const tokenResponse = await fetch(config.webAuthEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transaction: transaction.toXDR() }),
  })
  if (!tokenResponse.ok) {
    throw new Error(
      `SEP-10 token exchange failed with status ${tokenResponse.status}`,
    )
  }

  const tokenBody = (await tokenResponse.json()) as {
    token?: string
    access_token?: string
  }
  const token = tokenBody.token ?? tokenBody.access_token
  if (!token) {
    throw new Error('SEP-10 token response missing token')
  }

  const expiresAtMs = decodeJwtExpiryMs(token)
  if (expiresAtMs !== null) {
    tokenCache.set(cacheKey, { token, expiresAtMs })
  }

  return token
}
