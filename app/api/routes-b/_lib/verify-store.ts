type VerifyState = {
  expectedAmount: number
  attempts: number
  lockedUntil: number | null
}

const EXPECTED_AMOUNT = 0.01
const MAX_ATTEMPTS = 3
const LOCK_DURATION_MS = 24 * 60 * 60 * 1000

const store = new Map<string, VerifyState>()

export function startVerification(bankAccountId: string): { expectedAmount: number } {
  store.set(bankAccountId, { expectedAmount: EXPECTED_AMOUNT, attempts: 0, lockedUntil: null })
  return { expectedAmount: EXPECTED_AMOUNT }
}

export type ConfirmResult =
  | { ok: true }
  | { ok: false; locked: true; lockedUntil: number }
  | { ok: false; locked: false; attemptsLeft: number }
  | { ok: false; notStarted: true }

export function confirmVerification(bankAccountId: string, amount: number): ConfirmResult {
  const state = store.get(bankAccountId)
  if (!state) return { ok: false, notStarted: true }

  const now = Date.now()
  if (state.lockedUntil !== null && now < state.lockedUntil) {
    return { ok: false, locked: true, lockedUntil: state.lockedUntil }
  }

  if (Math.abs(amount - state.expectedAmount) < 0.001) {
    store.delete(bankAccountId)
    return { ok: true }
  }

  state.attempts += 1
  if (state.attempts >= MAX_ATTEMPTS) {
    state.lockedUntil = now + LOCK_DURATION_MS
    return { ok: false, locked: true, lockedUntil: state.lockedUntil }
  }

  return { ok: false, locked: false, attemptsLeft: MAX_ATTEMPTS - state.attempts }
}

export function resetVerifyStore(): void {
  store.clear()
}
