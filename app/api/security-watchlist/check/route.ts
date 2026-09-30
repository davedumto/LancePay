import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const value = searchParams.get('value')
    let type = searchParams.get('type')

    if (!value) {
      return NextResponse.json({ error: 'Missing value parameter' }, { status: 400 })
    }

    let normalizedValue = value.trim()

    // If type is not provided, try to infer it
    if (!type) {
      if (normalizedValue.includes('@')) {
        type = 'email'
      } else {
        type = 'wallet'
      }
    }

    if (type === 'email') {
      normalizedValue = normalizedValue.toLowerCase()
    } else if (type === 'wallet') {
      // Wallet addresses (Stellar/EVM) could be handled differently. 
      // For EVM, it's often lowercased or checksummed. For Stellar, it's case-sensitive but usually uppercase.
      // We keep it as is, or maybe just trimmed, but if we need a specific rule, we apply it here.
      // Assuming lowercase for simple EVM equivalence or leaving trimmed for Stellar.
      // We will leave it as trimmed for Stellar, or lowercased if it looks like EVM.
      // Actually, if it starts with 0x we can lowercase it.
      if (normalizedValue.startsWith('0x')) {
        normalizedValue = normalizedValue.toLowerCase()
      }
    }

    const entry = await prisma.securityWatchlist.findFirst({
      where: {
        value: normalizedValue,
        ...(type && { type })
      }
    })

    if (entry) {
      return NextResponse.json({
        match: true,
        type: entry.type
      })
    }

    return NextResponse.json({
      match: false
    })
  } catch (error) {
    console.error('GET /api/security-watchlist/check error', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
