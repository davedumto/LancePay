import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { Asset, StrKey } from '@stellar/stellar-sdk'
import { verifyAuthToken } from '@/lib/auth'
import { server } from '@/lib/stellar'
import { logger } from '@/lib/logger'

export const MAX_PATH_HOPS = 4
export const QUOTE_TTL_SECONDS = 60

export interface AssetDescriptor {
  code: string
  issuer?: string | null
}

interface HorizonPathAsset {
  asset_type: string
  asset_code?: string
  asset_issuer?: string
}

interface HorizonPathRecord {
  source_amount: string
  destination_amount: string
  path: HorizonPathAsset[]
}

function parseAssetDescriptor(raw: unknown, label: string): Asset {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${label} must be an object with code (and issuer for non-native assets)`)
  }
  const obj = raw as { code?: unknown; issuer?: unknown }
  const code = typeof obj.code === 'string' ? obj.code.trim().toUpperCase() : ''
  if (!code) {
    throw new Error(`${label}.code is required`)
  }
  if (code === 'XLM' || code === 'NATIVE') {
    return Asset.native()
  }
  const issuer = typeof obj.issuer === 'string' ? obj.issuer.trim() : ''
  if (!issuer || !StrKey.isValidEd25519PublicKey(issuer)) {
    throw new Error(`${label}.issuer must be a valid Stellar public key for non-native asset ${code}`)
  }
  return new Asset(code, issuer)
}

function formatHop(hop: HorizonPathAsset): AssetDescriptor {
  if (hop.asset_type === 'native') {
    return { code: 'XLM', issuer: null }
  }
  return {
    code: hop.asset_code ?? 'UNKNOWN',
    issuer: hop.asset_issuer ?? null,
  }
}

/**
 * POST /api/stellar/path-payments/preview
 * Previews a cross-asset Stellar path payment quote by consulting both
 * strictSendPaths and strictReceivePaths on Horizon, filtering paths to at
 * most MAX_PATH_HOPS intermediate hops, selecting whichever pathfinder yields
 * the best destination-per-source rate, and attaching a short-lived expiry.
 */
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization')
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : null
    const claims = token ? await verifyAuthToken(token) : null
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    let sourceAsset: Asset
    let destinationAsset: Asset
    try {
      sourceAsset = parseAssetDescriptor(body.sourceAsset, 'sourceAsset')
      destinationAsset = parseAssetDescriptor(
        body.destinationAsset,
        'destinationAsset',
      )
    } catch (assetErr) {
      return NextResponse.json(
        {
          error:
            assetErr instanceof Error
              ? assetErr.message
              : 'Invalid asset descriptor',
        },
        { status: 400 },
      )
    }

    const amountNum = Number(body.amount)
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return NextResponse.json(
        { error: 'amount must be a positive number' },
        { status: 400 },
      )
    }
    const amountStr = amountNum.toFixed(7).replace(/\.?0+$/, '') || String(amountNum)

    const direction =
      typeof body.direction === 'string'
        ? body.direction.trim().toLowerCase()
        : 'send'
    if (direction !== 'send' && direction !== 'receive') {
      return NextResponse.json(
        { error: 'direction must be either "send" or "receive"' },
        { status: 400 },
      )
    }

    const maxHops =
      body.maxHops !== undefined ? Number(body.maxHops) : MAX_PATH_HOPS
    if (
      !Number.isInteger(maxHops) ||
      maxHops < 0 ||
      maxHops > MAX_PATH_HOPS
    ) {
      return NextResponse.json(
        {
          error: `maxHops must be an integer between 0 and ${MAX_PATH_HOPS}`,
          code: 'MAX_HOPS_EXCEEDED',
        },
        { status: 400 },
      )
    }

    const horizonServer = server as unknown as {
      strictSendPaths: (
        sourceAsset: Asset,
        sourceAmount: string,
        destAssets: Asset[],
      ) => { limit: (n: number) => { call: () => Promise<{ records: HorizonPathRecord[] }> } }
      strictReceivePaths: (
        sourceAssets: Asset[],
        destAsset: Asset,
        destAmount: string,
      ) => { limit: (n: number) => { call: () => Promise<{ records: HorizonPathRecord[] }> } }
    }

    // Consult both strictSendPaths and strictReceivePaths
    const [strictSendRes, strictReceiveRes] = await Promise.all([
      horizonServer
        .strictSendPaths(sourceAsset, amountStr, [destinationAsset])
        .limit(10)
        .call(),
      horizonServer
        .strictReceivePaths([sourceAsset], destinationAsset, amountStr)
        .limit(10)
        .call(),
    ])

    type EvaluatedCandidate = {
      strategy: 'strict_send' | 'strict_receive'
      sourceAmount: string
      destinationAmount: string
      effectiveRate: number
      hops: AssetDescriptor[]
      hopCount: number
    }

    const candidates: EvaluatedCandidate[] = []

    for (const rec of strictSendRes?.records ?? []) {
      const hopList = Array.isArray(rec.path) ? rec.path : []
      if (hopList.length > maxHops) continue
      const srcAmt = Number(rec.source_amount)
      const dstAmt = Number(rec.destination_amount)
      if (!Number.isFinite(srcAmt) || srcAmt <= 0 || !Number.isFinite(dstAmt) || dstAmt <= 0) {
        continue
      }
      candidates.push({
        strategy: 'strict_send',
        sourceAmount: rec.source_amount,
        destinationAmount: rec.destination_amount,
        effectiveRate: Number((dstAmt / srcAmt).toFixed(8)),
        hops: hopList.map(formatHop),
        hopCount: hopList.length,
      })
    }

    for (const rec of strictReceiveRes?.records ?? []) {
      const hopList = Array.isArray(rec.path) ? rec.path : []
      if (hopList.length > maxHops) continue
      const srcAmt = Number(rec.source_amount)
      const dstAmt = Number(rec.destination_amount)
      if (!Number.isFinite(srcAmt) || srcAmt <= 0 || !Number.isFinite(dstAmt) || dstAmt <= 0) {
        continue
      }
      candidates.push({
        strategy: 'strict_receive',
        sourceAmount: rec.source_amount,
        destinationAmount: rec.destination_amount,
        effectiveRate: Number((dstAmt / srcAmt).toFixed(8)),
        hops: hopList.map(formatHop),
        hopCount: hopList.length,
      })
    }

    if (candidates.length === 0) {
      return NextResponse.json(
        {
          error: `No path found within ${maxHops} hops for ${sourceAsset.getCode()} -> ${destinationAsset.getCode()}`,
          code: 'NO_ELIGIBLE_PATH',
        },
        { status: 422 },
      )
    }

    // Pick whichever candidate yields the highest destination-per-source effectiveRate
    // (tie-breaking on fewer hops)
    candidates.sort((a, b) => {
      if (b.effectiveRate !== a.effectiveRate) {
        return b.effectiveRate - a.effectiveRate
      }
      return a.hopCount - b.hopCount
    })

    const best = candidates[0]
    const nowMs = Date.now()
    const expiresAtMs = nowMs + QUOTE_TTL_SECONDS * 1000
    const expiresAt = new Date(expiresAtMs).toISOString()
    const quoteId = `pq_${crypto.randomBytes(12).toString('hex')}`

    return NextResponse.json({
      quote: {
        quoteId,
        direction,
        selectedStrategy: best.strategy,
        sourceAsset: {
          code: sourceAsset.isNative() ? 'XLM' : sourceAsset.getCode(),
          issuer: sourceAsset.isNative() ? null : sourceAsset.getIssuer(),
        },
        destinationAsset: {
          code: destinationAsset.isNative()
            ? 'XLM'
            : destinationAsset.getCode(),
          issuer: destinationAsset.isNative()
            ? null
            : destinationAsset.getIssuer(),
        },
        sourceAmount: best.sourceAmount,
        destinationAmount: best.destinationAmount,
        effectiveRate: best.effectiveRate,
        path: best.hops,
        hopCount: best.hopCount,
        maxHopsConsidered: maxHops,
        ttlSeconds: QUOTE_TTL_SECONDS,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt,
      },
    })
  } catch (err) {
    logger?.error?.({ err }, 'POST /api/stellar/path-payments/preview error')
    return NextResponse.json(
      { error: 'Failed to preview Stellar path payment quote' },
      { status: 500 },
    )
  }
}
