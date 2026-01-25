import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { z } from 'zod'

const brandingSchema = z.object({
  logoUrl: z.string().url().optional().nullable(),
  primaryColor: z.string().regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Invalid hex color').optional(),
  footerText: z.string().max(500).optional().nullable(),
  signatureUrl: z.string().url().optional().nullable(),
})

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const branding = await prisma.brandingSettings.findUnique({
      where: { userId: user.id }
    })

    return NextResponse.json({
      success: true,
      branding: branding || {
        logoUrl: null,
        primaryColor: '#000000',
        footerText: null,
        signatureUrl: null,
      }
    })
  } catch (error) {
    console.error('Error fetching branding settings:', error)
    return NextResponse.json({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const body = await request.json()
    const result = brandingSchema.safeParse(body)

    if (!result.success) {
      return NextResponse.json({ 
        error: 'Validation failed', 
        details: result.error.flatten().fieldErrors 
      }, { status: 400 })
    }

    const { logoUrl, primaryColor, footerText, signatureUrl } = result.data

    const branding = await prisma.brandingSettings.upsert({
      where: { userId: user.id },
      update: {
        logoUrl,
        primaryColor,
        footerText,
        signatureUrl,
      },
      create: {
        userId: user.id,
        logoUrl,
        primaryColor: primaryColor || '#000000',
        footerText,
        signatureUrl,
      },
    })

    return NextResponse.json({
      success: true,
      message: 'Branding settings updated successfully',
      branding
    })
  } catch (error) {
    console.error('Error updating branding settings:', error)
    return NextResponse.json({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}
