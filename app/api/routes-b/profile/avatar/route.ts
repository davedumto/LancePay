import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { withBodyLimit } from '../../_lib/with-body-limit'

function isValidHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

async function patchAvatar(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { avatarUrl } = body ?? {}

  if (avatarUrl !== null && typeof avatarUrl !== 'string') {
    return NextResponse.json({ error: 'avatarUrl must be a string or null' }, { status: 400 })
  }

  if (typeof avatarUrl === 'string') {
    if (avatarUrl.length > 512) {
      return NextResponse.json({ error: 'avatarUrl must not exceed 512 characters' }, { status: 400 })
    }

    if (!isValidHttpsUrl(avatarUrl)) {
      return NextResponse.json({ error: 'avatarUrl must be a valid HTTPS URL' }, { status: 400 })
    }
  }

  const updatedUser = await prisma.user.update({
    where: { privyId: claims.userId },
    data: { avatarUrl: avatarUrl ?? null },
    select: { avatarUrl: true },
  })

  return NextResponse.json({ avatarUrl: updatedUser.avatarUrl })
}

export const PATCH = withBodyLimit(patchAvatar, { limitBytes: 2 * 1024 * 1024 })
