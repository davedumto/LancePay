import { NextRequest, NextResponse } from 'next/server'

interface NetworkInfo {
  id: string
  name: string
  displayName: string
  chainId?: string
  currency: string
  isEnabled: boolean
  isTestnet: boolean
}

const SUPPORTED_NETWORKS: NetworkInfo[] = [
  {
    id: 'stellar',
    name: 'stellar',
    displayName: 'Stellar',
    currency: 'USDC',
    isEnabled: true,
    isTestnet: process.env.NODE_ENV !== 'production',
  },
  {
    id: 'base',
    name: 'base',
    displayName: 'Base',
    chainId: '8453',
    currency: 'USDC',
    isEnabled: true,
    isTestnet: false,
  },
  {
    id: 'ethereum',
    name: 'ethereum',
    displayName: 'Ethereum',
    chainId: '1',
    currency: 'USDC',
    isEnabled: false,
    isTestnet: false,
  },
]

export async function GET(request: NextRequest) {
  try {
    return NextResponse.json({ networks: SUPPORTED_NETWORKS })
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
