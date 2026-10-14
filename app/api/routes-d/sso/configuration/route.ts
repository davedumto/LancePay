import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const ssoConfig = await (prisma as any).userSSOConfiguration.findUnique({
      where: { userId: user.id },
      select: {
        id: true,
        userId: true,
        provider: true,
        isEnabled: true,
        clientId: true,
        clientSecret: true,
        callbackUrl: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    if (!ssoConfig) {
      return NextResponse.json({
        configuration: null,
        message: 'No SSO configuration found',
      })
    }

    return NextResponse.json({
      configuration: {
        id: ssoConfig.id,
        provider: ssoConfig.provider,
        isEnabled: ssoConfig.isEnabled,
        callbackUrl: ssoConfig.callbackUrl,
        configuredAt: ssoConfig.updatedAt,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/sso/configuration error')
    return NextResponse.json({ error: 'Failed to fetch SSO configuration' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { provider, clientId, clientSecret, callbackUrl, isEnabled } = await request.json()

    if (!provider || typeof provider !== 'string' || provider.trim() === '') {
      return NextResponse.json({ error: 'provider is required' }, { status: 400 })
    }

    if (!clientId || typeof clientId !== 'string' || clientId.trim() === '') {
      return NextResponse.json({ error: 'clientId is required' }, { status: 400 })
    }

    if (!clientSecret || typeof clientSecret !== 'string' || clientSecret.trim() === '') {
      return NextResponse.json({ error: 'clientSecret is required' }, { status: 400 })
    }

    if (!callbackUrl || typeof callbackUrl !== 'string' || callbackUrl.trim() === '') {
      return NextResponse.json({ error: 'callbackUrl is required' }, { status: 400 })
    }

    const existingConfig = await (prisma as any).userSSOConfiguration.findUnique({
      where: { userId: user.id },
    })

    let config

    if (existingConfig) {
      config = await (prisma as any).userSSOConfiguration.update({
        where: { id: existingConfig.id },
        data: {
          provider: provider.trim(),
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
          callbackUrl: callbackUrl.trim(),
          isEnabled: isEnabled ?? true,
          updatedAt: new Date(),
        },
      })
    } else {
      config = await (prisma as any).userSSOConfiguration.create({
        data: {
          userId: user.id,
          provider: provider.trim(),
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
          callbackUrl: callbackUrl.trim(),
          isEnabled: isEnabled ?? true,
        },
      })
    }

    return NextResponse.json(
      {
        message: 'SSO configuration saved successfully',
        configuration: {
          id: config.id,
          provider: config.provider,
          isEnabled: config.isEnabled,
          callbackUrl: config.callbackUrl,
          configuredAt: config.updatedAt,
        },
      },
      { status: existingConfig ? 200 : 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/sso/configuration error')
    return NextResponse.json({ error: 'Failed to save SSO configuration' }, { status: 500 })
  }
}
