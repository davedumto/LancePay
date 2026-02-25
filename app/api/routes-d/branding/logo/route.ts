import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getBrandingLogoAbsolutePath } from '@/lib/file-storage'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
}

export async function GET(request: NextRequest) {
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
    })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const pathParam = request.nextUrl.searchParams.get('path')
    if (!pathParam || pathParam.includes('..')) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
    }

    // path must be userId/filename so user can only access their own logos
    const [pathUserId, ...rest] = pathParam.split('/')
    if (pathUserId !== user.id || rest.length === 0) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const logoUrl = '/branding-logos/' + pathParam
    const absolutePath = getBrandingLogoAbsolutePath(logoUrl)
    if (!absolutePath) {
      return NextResponse.json({ error: 'Invalid logo path' }, { status: 400 })
    }

    if (!existsSync(absolutePath)) {
      return NextResponse.json({ error: 'Logo not found' }, { status: 404 })
    }

    const fileBuffer = await readFile(absolutePath)
    const ext = path.extname(absolutePath).toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'

    return new NextResponse(fileBuffer, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="${path.basename(absolutePath)}"`,
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (error) {
    console.error('Branding logo serve error:', error)
    return NextResponse.json(
      { error: 'Failed to retrieve logo' },
      { status: 500 }
    )
  }
}
