import type { FxRateSnapshot, InvoiceFxLock } from '@prisma/client'
import { serializeFxRate } from '@/lib/fx-rates'

// Invoice FX locks freeze an FxRateSnapshot so the client sees a stable NGN
// amount. A lock is honored until expiresAt, which is always computed on the
// server from the configured TTL.

export const FX_LOCK_TARGET_CURRENCY = 'NGN'

const DEFAULT_TTL_MINUTES = 24 * 60
const DEFAULT_MAX_SNAPSHOT_AGE_MINUTES = 60

function positiveIntegerFromEnv(value: string | undefined, fallback: number): number {
  if (!value || !/^\d+$/.test(value.trim())) return fallback
  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** How long a new lock stays valid (INVOICE_FX_LOCK_TTL_MINUTES). */
export function fxLockTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerFromEnv(env.INVOICE_FX_LOCK_TTL_MINUTES, DEFAULT_TTL_MINUTES) * 60_000
}

/**
 * The oldest snapshot a new lock may freeze (INVOICE_FX_LOCK_MAX_SNAPSHOT_AGE_MINUTES),
 * so a lock never presents a stale market rate as current.
 */
export function fxLockMaxSnapshotAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerFromEnv(env.INVOICE_FX_LOCK_MAX_SNAPSHOT_AGE_MINUTES, DEFAULT_MAX_SNAPSHOT_AGE_MINUTES) * 60_000
}

/** A lock is expired from its expiresAt instant onwards. */
export function isFxLockExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime()
}

export function serializeFxLock(lock: InvoiceFxLock & { fxRateSnapshot: FxRateSnapshot }) {
  return {
    id: lock.id,
    invoiceId: lock.invoiceId,
    sourceAmount: lock.sourceAmount.toFixed(2),
    sourceCurrency: lock.sourceCurrency,
    lockedAmount: lock.lockedAmount.toFixed(2),
    lockedCurrency: lock.lockedCurrency,
    ...serializeFxRate({ snapshot: lock.fxRateSnapshot, inverted: lock.inverted }),
    lockedAt: lock.createdAt.toISOString(),
    expiresAt: lock.expiresAt.toISOString(),
  }
}
