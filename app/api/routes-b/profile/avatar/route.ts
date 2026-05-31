import { withRequestId } from '../../_lib/with-request-id'
import { withBodyLimit } from '../../_lib/with-body-limit'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { withCompression } from '../../_lib/with-compression'
import { errorResponse } from '../../_lib/errors'

function isValidHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

async function PATCHHandler(request: NextRequest) {
  const requestId = request.headers.get('x-request-id')

  try {
    const authToken = request.headers
      .get('authorization')
      ?.replace('Bearer ', '')

    const claims = await verifyAuthToken(authToken || '')

    if (!claims) {
      return withCompression(
        request,
        errorResponse('UNAUTHORIZED', 'Unauthorized', { requestId }, 401),
      )
    }

    let body: { avatarUrl?: unknown }

    try {
      body = await request.json()
    } catch {
      return withCompression(
        request,
        errorResponse('BAD_REQUEST', 'Invalid JSON body', { requestId }, 400),
      )
    }

    const { avatarUrl } = body ?? {}

    if (avatarUrl !== null && typeof avatarUrl !== 'string') {
      return withCompression(
        request,
        errorResponse('BAD_REQUEST', 'avatarUrl must be a string or null', { requestId }, 400),
      )
    }

    if (typeof avatarUrl === 'string') {
      if (avatarUrl.length > 512) {
        return withCompression(
          request,
          errorResponse('BAD_REQUEST', 'avatarUrl must not exceed 512 characters', { requestId }, 400),
        )
      }

      if (!isValidHttpsUrl(avatarUrl)) {
        return withCompression(
          request,
          errorResponse('BAD_REQUEST', 'avatarUrl must be a valid HTTPS URL', { requestId }, 400),
        )
      }
    }

    const updatedUser = await prisma.user.update({
      where: { privyId: claims.userId },
      data: { avatarUrl: avatarUrl ?? null },
      select: { avatarUrl: true },
    })

    return withCompression(
      request,
      NextResponse.json({
        avatarUrl: updatedUser.avatarUrl,
      }),
    )
  } catch (error) {
    logger.error({ err: error }, 'Routes B profile/avatar PATCH error')

    return withCompression(
      request,
      errorResponse(
        'INTERNAL',
        'Failed to update avatar',
        { requestId },
        500,
      ),
    )
  }
}

/**
 * Middleware order:
 * 1. requestId
 * 2. bodyLimit
 */
export const PATCH = withRequestId(
  withBodyLimit(PATCHHandler, {
    limitBytes: 2 * 1024 * 1024,
  })
)