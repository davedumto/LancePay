type WalletErrorClass = 'timeout' | 'rate-limit' | 'network' | 'schema-mismatch' | 'unknown'

export type WalletFailure = {
  errorClass: WalletErrorClass
  code: string
  status: number
}

type ClassifiedError = Error & {
  status?: number
  code?: string
  name?: string
}

export function classifyWalletError(error: unknown): WalletFailure {
  const err = (error ?? {}) as ClassifiedError
  const message = typeof err.message === 'string' ? err.message.toLowerCase() : ''

  if (err.name === 'AbortError' || message.includes('timeout') || err.code === 'ETIMEDOUT') {
    return { errorClass: 'timeout', code: 'WALLET_TIMEOUT', status: 504 }
  }

  if (err.status === 429 || message.includes('rate limit') || message.includes('too many requests')) {
    return { errorClass: 'rate-limit', code: 'WALLET_RATE_LIMITED', status: 429 }
  }

  if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || message.includes('network')) {
    return { errorClass: 'network', code: 'WALLET_NETWORK_ERROR', status: 502 }
  }

  if (message.includes('schema') || message.includes('invalid response') || message.includes('parse')) {
    return { errorClass: 'schema-mismatch', code: 'WALLET_SCHEMA_MISMATCH', status: 502 }
  }

  return { errorClass: 'unknown', code: 'WALLET_UNKNOWN_ERROR', status: 500 }
}
