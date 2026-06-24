/**
 * webhook-backoff.ts — Issue #607
 *
 * Per-webhook retry backoff configuration with validation and computation.
 * Backwards compatible: when no config is provided, the default curve
 * matches the previous global behaviour.
 */

// ── Types & defaults ──────────────────────────────────────────────────────────

export interface BackoffConfig {
  /** Initial retry delay in ms (50–5000). */
  initialMs: number;
  /** Maximum retry delay in ms (initialMs–60000). */
  maxMs: number;
  /** Multiplier applied to each successive attempt (1–5). */
  multiplier: number;
  /** Jitter as a fraction of the delay (0–1). 0 = deterministic, 1 = ±delay/2. */
  jitter: number;
}

/** Default curve — matches existing global behaviour. */
export const DEFAULT_BACKOFF: BackoffConfig = {
  initialMs: 1_000,
  maxMs: 30_000,
  multiplier: 2,
  jitter: 0.1,
};

// ── Validation ────────────────────────────────────────────────────────────────

export type BackoffValidation =
  | { ok: true; value: BackoffConfig }
  | { ok: false; error: string };

/**
 * Validate a partial backoff config and return a complete config or an error.
 * Missing fields fall back to DEFAULT_BACKOFF values.
 */
export function validateBackoff(input: Partial<BackoffConfig> | null | undefined): BackoffValidation {
  const merged: BackoffConfig = {
    initialMs: input?.initialMs ?? DEFAULT_BACKOFF.initialMs,
    maxMs: input?.maxMs ?? DEFAULT_BACKOFF.maxMs,
    multiplier: input?.multiplier ?? DEFAULT_BACKOFF.multiplier,
    jitter: input?.jitter ?? DEFAULT_BACKOFF.jitter,
  };

  if (!Number.isFinite(merged.initialMs) || merged.initialMs < 50 || merged.initialMs > 5_000) {
    return { ok: false, error: 'initialMs must be a number in [50, 5000]' };
  }
  if (!Number.isFinite(merged.maxMs) || merged.maxMs < merged.initialMs || merged.maxMs > 60_000) {
    return { ok: false, error: `maxMs must be in [initialMs (${merged.initialMs}), 60000]` };
  }
  if (!Number.isFinite(merged.multiplier) || merged.multiplier < 1 || merged.multiplier > 5) {
    return { ok: false, error: 'multiplier must be a number in [1, 5]' };
  }
  if (!Number.isFinite(merged.jitter) || merged.jitter < 0 || merged.jitter > 1) {
    return { ok: false, error: 'jitter must be a number in [0, 1]' };
  }

  return { ok: true, value: merged };
}

// ── Compute next delay ────────────────────────────────────────────────────────

/**
 * Compute the delay (in ms) before the next retry attempt.
 *
 * @param attempt 0-based attempt index. attempt=0 is the first retry after the
 *                initial failed delivery.
 * @param config  Per-webhook backoff configuration.
 * @param random  Optional RNG for deterministic tests; defaults to Math.random.
 */
export function computeBackoffDelay(
  attempt: number,
  config: BackoffConfig = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const exponential = config.initialMs * Math.pow(config.multiplier, safeAttempt);
  const capped = Math.min(exponential, config.maxMs);

  if (config.jitter <= 0) return capped;

  // Apply ±(jitter * delay / 2) variance — bounds: [capped*(1-j/2), capped*(1+j/2)]
  const variance = capped * config.jitter * (random() - 0.5);
  const delayed = capped + variance;
  return Math.max(0, Math.round(delayed));
}
