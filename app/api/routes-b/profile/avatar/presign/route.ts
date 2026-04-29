import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generatePresignedUpload } from '../../../_lib/presigned-upload'
import { registerRoute } from '../../../_lib/openapi'
import { z } from 'zod'

// Register OpenAPI documentation
registerRoute({
  method: 'POST',
  path: '/profile/avatar/presign',
  summary: 'Get presigned upload URL for avatar',
  description: 'Generate a presigned URL for direct avatar upload to storage.',
  responseSchema: z.object({
    url: z.string(),
    fields: z.record(z.string()),
    key: z.string(),
    expiresAt: z.string(),
  }),
  tags: ['profile']
})

async function POSTHandler(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const presignedUpload = generatePresignedUpload(user.id)

    return NextResponse.json(presignedUpload)
  } catch (error) {
    console.error('Avatar presign error:', error)
    return NextResponse.json({ error: 'Failed to generate presigned upload URL' }, { status: 500 })
  }
}

export const POST = withRequestId(POSTHandler)
