import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { randomUUID } from 'crypto'

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default lock TTL when the caller does not specify one. */
const DEFAULT_TTL_SECONDS = 300 // 5 minutes

/** Minimum / maximum caller-supplied TTL values (seconds). */
const MIN_TTL_SECONDS = 5
const MAX_TTL_SECONDS = 3600 // 1 hour

/** Minimum characters for the lock key. */
const MIN_KEY_LENGTH = 1

// ── POST /api/jobs/distributed-lock/acquire ───────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    // ── 1. Auth ───────────────────────────────────────────────────────────────
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    // ── 2. Parse & validate body ──────────────────────────────────────────────
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const raw = body as Record<string, unknown>

    // key — required
    if (
      !raw.key ||
      typeof raw.key !== 'string' ||
      raw.key.trim().length < MIN_KEY_LENGTH
    ) {
      return NextResponse.json({ error: 'key is required' }, { status: 400 })
    }
    const key = raw.key.trim()

    // ttl — optional, defaults to DEFAULT_TTL_SECONDS
    let ttlSeconds = DEFAULT_TTL_SECONDS
    if (raw.ttlSeconds !== undefined) {
      const parsed = Number(raw.ttlSeconds)
      if (!Number.isInteger(parsed) || parsed < MIN_TTL_SECONDS || parsed > MAX_TTL_SECONDS) {
        return NextResponse.json(
          {
            error: `ttlSeconds must be an integer between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS}`,
          },
          { status: 400 },
        )
      }
      ttlSeconds = parsed
    }

    // holder — optional label for the acquiring instance
    const holder =
      raw.holder && typeof raw.holder === 'string' ? raw.holder.trim().slice(0, 255) : null

    // ── 3. Atomic conditional acquire ─────────────────────────────────────────
    //
    // Strategy: attempt an upsert that only writes when there is NO live lock
    // (i.e. the row either does not exist, or its expiresAt is in the past).
    //
    // We use a raw SQL INSERT ... ON CONFLICT ... DO UPDATE ... WHERE to make
    // the "check-then-write" a single atomic statement, eliminating the TOCTOU
    // race that a read-then-write approach would have.
    //
    //   INSERT INTO "DistributedLock" (key, token, holder, "acquiredAt", "expiresAt", version)
    //   VALUES ($key, $token, $holder, now(), $expiresAt, 1)
    //   ON CONFLICT (key)
    //   DO UPDATE SET
    //     token      = EXCLUDED.token,
    //     holder     = EXCLUDED.holder,
    //     "acquiredAt" = EXCLUDED."acquiredAt",
    //     "expiresAt"  = EXCLUDED."expiresAt",
    //     version    = "DistributedLock".version + 1
    //   WHERE "DistributedLock"."expiresAt" < now()
    //
    // If the WHERE clause is false (lock is still live) PostgreSQL performs no
    // update and returns 0 rows affected — that is our conflict signal.

    const token = randomUUID()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000)

    const affected = await prisma.$executeRaw`
      INSERT INTO "DistributedLock" (key, token, holder, "acquiredAt", "expiresAt", version)
      VALUES (${key}, ${token}, ${holder}, ${now}, ${expiresAt}, 1)
      ON CONFLICT (key)
      DO UPDATE SET
        token        = EXCLUDED.token,
        holder       = EXCLUDED.holder,
        "acquiredAt" = EXCLUDED."acquiredAt",
        "expiresAt"  = EXCLUDED."expiresAt",
        version      = "DistributedLock".version + 1
      WHERE "DistributedLock"."expiresAt" < ${now}
    `

    // ── 4. Conflict: another instance holds a live lock ───────────────────────
    if (affected === 0) {
      // Fetch the current lock so the caller knows when it expires
      const current = await prisma.distributedLock.findUnique({ where: { key } })

      return NextResponse.json(
        {
          error: 'Lock is already held',
          key,
          holder: current?.holder ?? null,
          expiresAt: current?.expiresAt ?? null,
        },
        { status: 409 },
      )
    }

    // ── 5. Acquired ───────────────────────────────────────────────────────────
    logger.error(
      { key, holder, ttlSeconds },
      'POST /api/jobs/distributed-lock/acquire — lock acquired',
    )

    return NextResponse.json(
      {
        lock: {
          key,
          token,
          holder,
          acquiredAt: now,
          expiresAt,
          ttlSeconds,
        },
        message: 'Lock acquired',
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/jobs/distributed-lock/acquire error')
    return NextResponse.json({ error: 'Failed to acquire lock' }, { status: 500 })
  }
}
