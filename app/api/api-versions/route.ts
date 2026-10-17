import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

export type ApiVersionStatus = 'current' | 'active' | 'deprecated' | 'sunset'

export interface ApiVersionDescriptor {
  version: string
  status: ApiVersionStatus
  isDefault: boolean
  releaseDate: string
  deprecationDate: string | null
  sunsetDate: string | null
  changelogUrl: string
}

export const EDGE_CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=60'

export const DEFAULT_API_VERSION = '2026-06-01'

/**
 * Canonical public API version catalog for LancePay.
 * Ordered newest-first so SDKs and API consumers can inspect release & sunset timelines.
 */
export const SUPPORTED_API_VERSIONS: readonly ApiVersionDescriptor[] = Object.freeze([
  {
    version: '2026-06-01',
    status: 'current',
    isDefault: true,
    releaseDate: '2026-06-01T00:00:00.000Z',
    deprecationDate: null,
    sunsetDate: null,
    changelogUrl: 'https://docs.lancepay.io/changelog/2026-06-01',
  },
  {
    version: '2025-11-01',
    status: 'active',
    isDefault: false,
    releaseDate: '2025-11-01T00:00:00.000Z',
    deprecationDate: null,
    sunsetDate: '2027-05-01T00:00:00.000Z',
    changelogUrl: 'https://docs.lancepay.io/changelog/2025-11-01',
  },
  {
    version: '2025-05-01',
    status: 'deprecated',
    isDefault: false,
    releaseDate: '2025-05-01T00:00:00.000Z',
    deprecationDate: '2026-05-01T00:00:00.000Z',
    sunsetDate: '2026-12-31T23:59:59.000Z',
    changelogUrl: 'https://docs.lancepay.io/changelog/2025-05-01',
  },
  {
    version: '2024-10-01',
    status: 'sunset',
    isDefault: false,
    releaseDate: '2024-10-01T00:00:00.000Z',
    deprecationDate: '2025-05-01T00:00:00.000Z',
    sunsetDate: '2026-01-01T00:00:00.000Z',
    changelogUrl: 'https://docs.lancepay.io/changelog/2024-10-01',
  },
])

const VALID_STATUSES: ReadonlySet<ApiVersionStatus> = new Set([
  'current',
  'active',
  'deprecated',
  'sunset',
])

function toIsoOrNull(val: unknown): string | null {
  if (!val) return null
  if (val instanceof Date) return val.toISOString()
  if (typeof val === 'string') {
    const parsed = new Date(val)
    return Number.isNaN(parsed.getTime()) ? val : parsed.toISOString()
  }
  return null
}

function normalizeVersionRow(row: any, now: Date): ApiVersionDescriptor {
  const releaseDate = toIsoOrNull(row.releaseDate) ?? new Date(0).toISOString()
  const deprecationDate = toIsoOrNull(row.deprecationDate)
  const sunsetDate = toIsoOrNull(row.sunsetDate)

  let status: ApiVersionStatus = VALID_STATUSES.has(row.status) ? row.status : 'active'
  if (sunsetDate && new Date(sunsetDate).getTime() <= now.getTime()) {
    status = 'sunset'
  } else if (
    status === 'active' &&
    deprecationDate &&
    new Date(deprecationDate).getTime() <= now.getTime()
  ) {
    status = 'deprecated'
  }

  return {
    version: String(row.version),
    status,
    isDefault: Boolean(row.isDefault ?? status === 'current'),
    releaseDate,
    deprecationDate,
    sunsetDate,
    changelogUrl:
      typeof row.changelogUrl === 'string' && row.changelogUrl.trim().length > 0
        ? row.changelogUrl.trim()
        : `https://docs.lancepay.io/changelog/${String(row.version)}`,
  }
}

async function loadApiVersions(now: Date): Promise<ApiVersionDescriptor[]> {
  const dbModel = (prisma as any)?.apiVersion
  if (dbModel && typeof dbModel.findMany === 'function') {
    const rows = await dbModel.findMany({
      orderBy: { releaseDate: 'desc' },
    })
    if (Array.isArray(rows) && rows.length > 0) {
      return rows.map((r) => normalizeVersionRow(r, now))
    }
  }
  return SUPPORTED_API_VERSIONS.map((v) => normalizeVersionRow(v, now))
}

/**
 * GET /api/api-versions
 * Returns supported public API versions, lifecycle status, release/sunset dates,
 * changelog URLs, and a top-level `currentDefaultVersion` field with edge caching headers.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const statusFilter = searchParams.get('status')?.trim().toLowerCase() ?? null
    const includeSunsetParam = searchParams.get('includeSunset')?.trim().toLowerCase() ?? null

    if (statusFilter && !VALID_STATUSES.has(statusFilter as ApiVersionStatus)) {
      return NextResponse.json(
        {
          error: 'Invalid status filter. Allowed values: current, active, deprecated, sunset',
          code: 'INVALID_STATUS_FILTER',
        },
        { status: 400 }
      )
    }

    if (
      includeSunsetParam !== null &&
      includeSunsetParam !== 'true' &&
      includeSunsetParam !== 'false'
    ) {
      return NextResponse.json(
        {
          error: 'includeSunset must be "true" or "false"',
          code: 'INVALID_QUERY_PARAM',
        },
        { status: 400 }
      )
    }

    const now = new Date()
    const allVersions = await loadApiVersions(now)

    const defaultDescriptor =
      allVersions.find((v) => v.isDefault && v.status !== 'sunset') ??
      allVersions.find((v) => v.status === 'current') ??
      allVersions.find((v) => v.status === 'active') ??
      allVersions[0]

    const currentDefaultVersion = defaultDescriptor?.version ?? DEFAULT_API_VERSION

    const includeSunset = includeSunsetParam === null ? true : includeSunsetParam === 'true'

    const filteredVersions = allVersions.filter((item) => {
      if (!includeSunset && item.status === 'sunset') return false
      if (statusFilter && item.status !== statusFilter) return false
      return true
    })

    const response = NextResponse.json(
      {
        currentDefaultVersion,
        versionHeader: 'LancePay-Version',
        total: filteredVersions.length,
        versions: filteredVersions.map((v) => ({
          version: v.version,
          status: v.status,
          releaseDate: v.releaseDate,
          deprecationDate: v.deprecationDate,
          sunsetDate: v.sunsetDate,
          changelogUrl: v.changelogUrl,
        })),
      },
      {
        status: 200,
        headers: {
          'Cache-Control': EDGE_CACHE_CONTROL,
          'X-API-Default-Version': currentDefaultVersion,
        },
      }
    )

    return response
  } catch (error) {
    logger.error({ err: error }, 'GET /api/api-versions error')
    return NextResponse.json(
      { error: 'Failed to retrieve supported API versions' },
      { status: 500 }
    )
  }
}
