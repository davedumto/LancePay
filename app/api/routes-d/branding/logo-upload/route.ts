import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { storeBrandingLogoFile, validateLogoFile } from '@/lib/file-storage'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) as const }
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return { error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) as const }
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return { error: NextResponse.json({ error: 'User not found' }, { status: 404 }) as const }
  }

  return { user }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser(request)
    if ('error' in auth) return auth.error

    const { user } = auth
    const formData = await request.formData()
    const file = formData.get('logo')

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Logo file is required' }, { status: 400 })
    }

    const validation = validateLogoFile(file)
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error || 'Invalid logo file' },
        { status: 400 },
      )
    }

    const logoUrl = await storeBrandingLogoFile(user.id, file)

    return NextResponse.json({ logoUrl }, { status: 201 })
  } catch (error) {
    console.error('Error uploading branding logo:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    )
  }
}

