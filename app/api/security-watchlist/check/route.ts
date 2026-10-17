import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { normalizeWatchlistValue } from '../route'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const value = searchParams.get('value')
    const rawType = searchParams.get('type')

    if (!value || !value.trim()) {
      return NextResponse.json({ error: 'Missing value parameter' }, { status: 400 })
    }

    const trimmedValue = value.trim()

    // If type is not provided, infer it from the value
    const type = rawType?.trim()
      ? rawType.trim().toLowerCase()
      : trimmedValue.includes('@')
        ? 'email'
        : 'wallet'

    const normalizedValue = normalizeWatchlistValue(trimmedValue, type)

    const entry = await prisma.securityWatchlist.findFirst({
      where: {
        value: normalizedValue,
        ...(type && { type }),
      },
    })

    if (entry) {
      return NextResponse.json({
        match: true,
        type: entry.type,
      })
    }

    return NextResponse.json({
      match: false,
    })
  } catch (error) {
    console.error('GET /api/security-watchlist/check error', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
