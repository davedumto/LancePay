import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const VALID_PLATFORMS = ['ios', 'android', 'web'] as const
type Platform = typeof VALID_PLATFORMS[number]

const MIN_VERSIONS: Record<Platform, string> = {
  ios: '1.2.0',
  android: '1.1.0',
  web: '1.0.0',
}

const REC_VERSIONS: Record<Platform, string> = {
  ios: '2.0.0',
  android: '2.0.0',
  web: '1.0.0',
}

function parseVersion(v: string) {
  const parts = v.split('.').map(p => Number.parseInt(p, 10))
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null
  return { major: parts[0]!, minor: parts[1]!, patch: parts[2]! }
}

function isVersionLessThan(v1: string, v2: string) {
  const p1 = parseVersion(v1)
  const p2 = parseVersion(v2)
  if (!p1 || !p2) return false
  if (p1.major !== p2.major) return p1.major < p2.major
  if (p1.minor !== p2.minor) return p1.minor < p2.minor
  return p1.patch < p2.patch
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { searchParams } = request.nextUrl
    const platform = searchParams.get('platform')?.toLowerCase()
    const version = searchParams.get('version')

    if (!platform || !VALID_PLATFORMS.includes(platform as Platform)) {
      return NextResponse.json(
        { error: `platform must be one of: ${VALID_PLATFORMS.join(', ')}` },
        { status: 400 },
      )
    }

    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      return NextResponse.json({ error: 'version must be in SemVer format (x.y.z)' }, { status: 400 })
    }

    const minVersion = MIN_VERSIONS[platform as Platform]
    const recVersion = REC_VERSIONS[platform as Platform]

    const updateRequired = isVersionLessThan(version, minVersion)
    const updateRecommended = !updateRequired && isVersionLessThan(version, recVersion)
    const compatible = !updateRequired

    return NextResponse.json({
      compatible,
      updateRequired,
      updateRecommended,
      minimumVersion: minVersion,
      recommendedVersion: recVersion,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/app/compatibility error')
    return NextResponse.json({ error: 'Failed to check app compatibility' }, { status: 500 })
  }
}
