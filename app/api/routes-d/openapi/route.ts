import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

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
      return NextResponse.json({ error: 'User not found' }, { status: 401 })
    }

    // Build the OpenAPI 3.1.0 specification object
    const spec = {
      openapi: '3.1.0',
      info: {
        title: 'LancePay Routes-D API',
        description: 'API specification for LancePay routes-d endpoints',
        version: '1.0.0',
      },
      servers: [
        {
          url: '/api/routes-d',
          description: 'Local API route',
        },
      ],
      paths: {
        '/openapi': {
          get: {
            summary: 'Serve the OpenAPI spec',
            responses: {
              '200': { description: 'OpenAPI JSON document' },
              '401': { description: 'Unauthorized' },
            },
          },
        },
        '/wallet/balances': {
          get: {
            summary: 'Fetch multi-currency wallet balances',
            responses: {
              '200': { description: 'Balances list' },
              '401': { description: 'Unauthorized' },
            },
          },
        },
        '/bank-statements/import': {
          post: {
            summary: 'Import a bank statement',
            responses: {
              '200': { description: 'Import summary' },
              '400': { description: 'Bad Request' },
              '401': { description: 'Unauthorized' },
              '404': { description: 'Not Found' },
            },
          },
        },
        '/gas/estimate': {
          post: {
            summary: 'Estimate gas fee for a transaction',
            responses: {
              '200': { description: 'Gas fee estimate' },
              '400': { description: 'Bad Request' },
              '401': { description: 'Unauthorized' },
            },
          },
        },
        '/system/health': {
          get: {
            summary: 'System health status check',
            responses: {
              '200': { description: 'Healthy' },
            },
          },
        },
      },
    }

    return NextResponse.json(spec)
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to serve OpenAPI spec' },
      { status: 500 }
    )
  }
}
