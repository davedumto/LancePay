import {
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk'

/**
 * Runtime config for Stellar network operations.
 * Values are loaded lazily to avoid import-time failures in serverless environments.
 */
type StellarRuntimeConfig = {
  horizonUrl: string
  networkPassphrase: string
  fundingSecret: string
  startingBalanceXlm: string
  lowBalanceThresholdXlm: string
}

/**
 * Funding operation outcome.
 * - "funded": createAccount submitted successfully
 * - "skipped": destination already exists (or raced and already exists)
 * - "failed": definitive failure (non-retryable or retries exhausted)
 */
export type FundStatus = 'funded' | 'skipped' | 'failed'

export type FundResult = {
  status: FundStatus
  destination: string
  txHash?: string
  reason?: string
  lowBalance?: boolean
}

/**
 * Error with stable code for routing decisions (retry/skip/alert).
 */
class StellarFundingError extends Error {
  public readonly code: string
  public readonly destination?: string

  constructor(message: string, code: string, destination?: string) {
    super(message)
    this.name = 'StellarFundingError'
    this.code = code
    this.destination = destination
  }
}

type HorizonErrorLike = {
  response?: {
    status?: number
    data?: {
      extras?: {
        result_codes?: {
          transaction?: string
          operations?: string[]
        }
      }
    }
  }
}

const RETRY_POLICY = {
  maxAttempts: 3,
  baseDelayMs: 750,
  maxDelayMs: 8000,
}

/**
 * Load config from env with strict validation.
 * Avoids non-null assertions and prevents import-time crashes.
 */
function getConfig(): StellarRuntimeConfig {
  const network = (process.env.STELLAR_NETWORK || 'testnet').toLowerCase()
  const isMainnet = network === 'mainnet' || network === 'public'

  const fundingSecret = process.env.STELLAR_FUNDING_WALLET_SECRET
  if (!fundingSecret) {
    throw new StellarFundingError(
      'Missing STELLAR_FUNDING_WALLET_SECRET environment variable.',
      'ENV_MISSING_FUNDING_SECRET'
    )
  }

  if (!StrKey.isValidEd25519SecretSeed(fundingSecret)) {
    throw new StellarFundingError(
      'Invalid STELLAR_FUNDING_WALLET_SECRET format.',
      'ENV_INVALID_FUNDING_SECRET'
    )
  }

  return {
    horizonUrl: isMainnet
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org',
    networkPassphrase: isMainnet ? Networks.PUBLIC : Networks.TESTNET,
    fundingSecret,
    startingBalanceXlm: '2.0',
    lowBalanceThresholdXlm: '100.0',
  }
}

/**
 * Horizon server instances keyed by URL to prevent cross-network contamination.
 */
const serverByUrl = new Map<string, Horizon.Server>()

function getServer(horizonUrl: string): Horizon.Server {
  const existing = serverByUrl.get(horizonUrl)
  if (existing) return existing

  const created = new Horizon.Server(horizonUrl)
  serverByUrl.set(horizonUrl, created)
  return created
}

function getFundingKeypair(fundingSecret: string): Keypair {
  return Keypair.fromSecret(fundingSecret)
}

/**
 * Convert decimal XLM string to stroops (1 XLM = 10^7 stroops) using bigint.
 * This avoids floating point rounding errors.
 */
function xlmToStroops(xlm: string): bigint {
  const trimmed = xlm.trim()
  if (!trimmed) throw new StellarFundingError('Empty XLM amount.', 'AMOUNT_EMPTY')

  const negative = trimmed.startsWith('-')
  if (negative) throw new StellarFundingError('Negative XLM amount.', 'AMOUNT_NEGATIVE')

  const [wholePartRaw, fracPartRaw = ''] = trimmed.split('.')
  const wholePart = wholePartRaw.replace(/^0+(?=\d)/, '') || '0'
  const fracPart = (fracPartRaw + '0000000').slice(0, 7)

  if (!/^\d+$/.test(wholePart) || !/^\d+$/.test(fracPart)) {
    throw new StellarFundingError('Invalid XLM amount format.', 'AMOUNT_INVALID')
  }

  const stroopsStr = `${wholePart}${fracPart}`
  return BigInt(stroopsStr)
}

function isValidDestination(destination: string): boolean {
  return StrKey.isValidEd25519PublicKey(destination)
}

/**
 * Horizon loadAccount:
 * - returns account if exists
 * - throws error with status 404 if not found
 */
async function destinationExists(server: Horizon.Server, destination: string): Promise<boolean> {
  try {
    await server.loadAccount(destination)
    return true
  } catch (e) {
    const err = e as HorizonErrorLike
    const status = err?.response?.status
    if (status === 404) return false
    throw e
  }
}

function extractResultCodes(e: unknown): { tx?: string; ops?: string[]; status?: number } {
  const err = e as HorizonErrorLike
  return {
    status: err?.response?.status,
    tx: err?.response?.data?.extras?.result_codes?.transaction,
    ops: err?.response?.data?.extras?.result_codes?.operations,
  }
}

function isRetryableError(e: unknown): boolean {
  const { status, tx } = extractResultCodes(e)

  // Network / gateway timeouts
  if (status === 504 || status === 502 || status === 503) return true

  // Common transient transaction codes
  if (tx === 'tx_bad_seq') return true

  return false
}

function isAlreadyExistsError(e: unknown): boolean {
  const { tx, ops } = extractResultCodes(e)

  // Depending on Horizon/SDK versions, "already exists" might appear as operation-level codes.
  // We treat any op_already_exists as idempotent success.
  if (ops && ops.some((c) => c === 'op_already_exists')) return true

  // Some environments may classify destination existence as a tx failure.
  // We keep this conservative; most commonly it's operation-level.
  if (tx === 'tx_failed' && ops && ops.includes('op_already_exists')) return true

  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function computeBackoffMs(attempt: number): number {
  const exp = Math.min(
    RETRY_POLICY.baseDelayMs * 2 ** (attempt - 1),
    RETRY_POLICY.maxDelayMs
  )
  const jitter = Math.floor(Math.random() * 250)
  return exp + jitter
}

async function getNativeBalanceStroops(server: Horizon.Server, publicKey: string): Promise<bigint> {
  const account = await server.loadAccount(publicKey)
  const native = account.balances.find((b) => b.asset_type === 'native')
  if (!native || !('balance' in native)) {
    throw new StellarFundingError(
      'Native XLM balance not found.',
      'BALANCE_NATIVE_NOT_FOUND',
      publicKey
    )
  }
  return xlmToStroops(native.balance)
}

/**
 * Submit createAccount with bounded retries for transient errors.
 * Handles "already exists" as a skip (idempotent success).
 */
async function submitCreateAccountWithRetry(params: {
  server: Horizon.Server
  networkPassphrase: string
  fundingKeypair: Keypair
  destination: string
  startingBalanceXlm: string
}): Promise<{ status: 'funded' | 'skipped'; txHash?: string; reason?: string }> {
  const { server, networkPassphrase, fundingKeypair, destination, startingBalanceXlm } = params

  for (let attempt = 1; attempt <= RETRY_POLICY.maxAttempts; attempt++) {
    try {
      const sourceAccount = await server.loadAccount(fundingKeypair.publicKey())

      const tx = new TransactionBuilder(sourceAccount, {
        fee: String(BASE_FEE),
        networkPassphrase,
      })
        .addOperation(
          Operation.createAccount({
            destination,
            startingBalance: startingBalanceXlm,
          })
        )
        .setTimeout(180)
        .build()

      tx.sign(fundingKeypair)

      const result = await server.submitTransaction(tx)

      console.info('Account funded successfully', {
        destination,
        txHash: result.hash,
        startingBalance: startingBalanceXlm,
        attempt,
      })

      return { status: 'funded', txHash: result.hash }
    } catch (e) {
      if (isAlreadyExistsError(e)) {
        return { status: 'skipped', reason: 'destination_already_exists' }
      }

      if (attempt < RETRY_POLICY.maxAttempts && isRetryableError(e)) {
        const delay = computeBackoffMs(attempt)
        console.warn('Stellar funding retry scheduled', {
          destination,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts: RETRY_POLICY.maxAttempts,
          delayMs: delay,
          error: extractResultCodes(e),
        })
        await sleep(delay)
        continue
      }

      const { status, tx, ops } = extractResultCodes(e)
      throw new StellarFundingError(
        `CreateAccount transaction failed (status=${status ?? 'n/a'}, tx=${tx ?? 'n/a'}, ops=${
          ops?.join(',') ?? 'n/a'
        }).`,
        'TX_SUBMIT_FAILED',
        destination
      )
    }
  }

  throw new StellarFundingError('Retries exhausted.', 'RETRIES_EXHAUSTED', params.destination)
}

/**
 * fundNewWallet
 *
 * Idempotent behavior:
 * - If destination already exists: returns { status: "skipped" }
 * - If createAccount races and destination gets created concurrently: returns { status: "skipped" }
 * - Otherwise: creates the account with configured starting balance
 *
 * Operational behavior:
 * - After funding attempt (funded/skipped), checks funding wallet balance and flags lowBalance if below threshold.
 * - Does NOT send alerts directly in this step; returns lowBalance flag for the caller to alert.
 */
export async function fundNewWallet(destination: string): Promise<FundResult> {
  if (!isValidDestination(destination)) {
    return {
      status: 'failed',
      destination,
      reason: 'invalid_destination_public_key',
    }
  }

  const cfg = getConfig()
  const server = getServer(cfg.horizonUrl)
  const fundingKeypair = getFundingKeypair(cfg.fundingSecret)

  try {
    const exists = await destinationExists(server, destination)
    if (exists) {
      const lowBalance = await isFundingWalletLowBalance({
        server,
        fundingPublicKey: fundingKeypair.publicKey(),
        thresholdXlm: cfg.lowBalanceThresholdXlm,
      })

      return {
        status: 'skipped',
        destination,
        reason: 'destination_already_exists',
        lowBalance,
      }
    }

    const submit = await submitCreateAccountWithRetry({
      server,
      networkPassphrase: cfg.networkPassphrase,
      fundingKeypair,
      destination,
      startingBalanceXlm: cfg.startingBalanceXlm,
    })

    const lowBalance = await isFundingWalletLowBalance({
      server,
      fundingPublicKey: fundingKeypair.publicKey(),
      thresholdXlm: cfg.lowBalanceThresholdXlm,
    })

    return {
      status: submit.status,
      destination,
      txHash: submit.txHash,
      reason: submit.reason,
      lowBalance,
    }
  } catch (e) {
    const err = e as Error
    console.error('Stellar funding failed', {
      destination,
      errorCode: e instanceof StellarFundingError ? e.code : 'UNKNOWN',
      errorMessage: err?.message ?? 'Unknown error',
      horizonDetails: extractResultCodes(e),
    })

    return {
      status: 'failed',
      destination,
      reason: err?.message ?? 'unknown_error',
    }
  }
}

/**
 * Return funding wallet public key derived from configured secret.
 * Useful for operational monitoring or debugging (never exposes the secret).
 */
export function getFundingWalletPublicKey(): string {
  const cfg = getConfig()
  const kp = getFundingKeypair(cfg.fundingSecret)
  return kp.publicKey()
}

async function isFundingWalletLowBalance(params: {
  server: Horizon.Server
  fundingPublicKey: string
  thresholdXlm: string
}): Promise<boolean> {
  const { server, fundingPublicKey, thresholdXlm } = params

  try {
    const balance = await getNativeBalanceStroops(server, fundingPublicKey)
    const threshold = xlmToStroops(thresholdXlm)
    return balance < threshold
  } catch (e) {
    console.warn('Funding wallet balance check failed', {
      fundingPublicKey,
      horizonError: extractResultCodes(e),
      impact: 'lowBalance flag will be false',
    })
    return false
  }
}
