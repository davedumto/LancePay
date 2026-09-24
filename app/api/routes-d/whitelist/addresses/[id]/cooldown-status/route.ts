import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// Cooldown status response type
export interface CooldownStatusResponse {
  id: string
  address: string
  eligible: boolean // explicit boolean — caller never computes this
  cooldownEndsAt: string // ISO timestamp when cooldown ends
  remainingSeconds: number // seconds remaining (0 if eligible)
  remainingMinutes: number // minutes remaining (0 if eligible)
  createdAt: string
}

// Helper to authenticate user
async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

// GET /api/routes-d/whitelist/addresses/[id]/cooldown-status — fetch cooldown status for a whitelisted address
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // 1. Authenticate
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required' },
        { status: 401 }
      )
    }

    const { id } = params

    // 2. Find whitelist address
    const whitelistAddress = await prisma.whitelistAddress.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        address: true,
        createdAt: true,
      },
    })

    // 3. Return 404 if not found
    if (!whitelistAddress) {
      return NextResponse.json(
        { error: 'Not Found', message: 'Whitelist address not found' },
        { status: 404 }
      )
    }

    // 4. Ownership check
    if (whitelistAddress.userId !== user.id) {
      return NextResponse.json(
        { error: 'Forbidden', message: 'You do not own this whitelist address' },
        { status: 403 }
      )
    }

    // 5. Compute cooldown status
    const COOLDOWN_HOURS = parseInt(process.env.WHITELIST_COOLDOWN_HOURS ?? '24')
    const COOLDOWN_MS = COOLDOWN_HOURS * 60 * 60 * 1000

    const now = new Date()
    const createdAt = whitelistAddress.createdAt
    const cooldownEndsAt = new Date(createdAt.getTime() + COOLDOWN_MS)

    const remainingMs = Math.max(0, cooldownEndsAt.getTime() - now.getTime())
    const remainingSeconds = Math.floor(remainingMs / 1000)
    const remainingMinutes = Math.floor(remainingSeconds / 60)
    const eligible = remainingMs === 0

    logger.info(
      {
        userId: user.id,
        whitelistAddressId: id,
        eligible,
        remainingSeconds,
      },
      'GET /api/routes-d/whitelist/addresses/[id]/cooldown-status'
    )

    return NextResponse.json(
      {
        id: whitelistAddress.id,
        address: whitelistAddress.address,
        eligible, // explicit boolean
        cooldownEndsAt: cooldownEndsAt.toISOString(),
        remainingSeconds,
        remainingMinutes,
        createdAt: createdAt.toISOString(),
      } as CooldownStatusResponse,
      { status: 200 }
    )
  } catch (error) {
    logger.error(
      { err: error },
      'GET /api/routes-d/whitelist/addresses/[id]/cooldown-status error'
    )
    return NextResponse.json(
      { error: 'Internal Server Error', message: 'Failed to fetch cooldown status' },
      { status: 500 }
    )
  }
}
