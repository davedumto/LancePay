import { logger } from '@/lib/logger'

type RetryableError = Error & {
  status?: number
  code?: string
}

type RetryContext = {
  attempt: number
  maxAttempts: number
}

type RetryOptions = {
  maxAttempts?: number
  baseDelayMs?: number
  shouldRetry?: (error: RetryableError, context: RetryContext) => boolean
  onRetry?: (payload: { attempt: number; delay: number; error: string }) => void
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function isRetryableStatusError(error: RetryableError): boolean {
  return typeof error.status === 'number' && error.status >= 500
}

export function isNetworkError(error: RetryableError): boolean {
  return Boolean(error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT')
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3
  const baseDelayMs = options.baseDelayMs ?? 200
  const shouldRetry =
    options.shouldRetry ??
    ((error: RetryableError) => isRetryableStatusError(error) || isNetworkError(error))

  let attempt = 0
  let lastError: RetryableError | undefined

  while (attempt < maxAttempts) {
    attempt += 1
    try {
      return await fn()
    } catch (error) {
      const typedError = error as RetryableError
      lastError = typedError
      const canRetry = attempt < maxAttempts && shouldRetry(typedError, { attempt, maxAttempts })
      if (!canRetry) {
        throw typedError
      }

      const expDelay = baseDelayMs * 2 ** (attempt - 1)
      const jitter = Math.floor(Math.random() * 75)
      const delay = expDelay + jitter
      const payload = { attempt, delay, error: typedError.message || 'Unknown error' }
      options.onRetry?.(payload)
      logger.warn(payload, 'Retrying operation after transient failure')
      await sleep(delay)
    }
  }

  throw lastError ?? new Error('Retry failed')
}
