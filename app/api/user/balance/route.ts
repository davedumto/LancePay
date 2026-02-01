import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getAccountBalance } from '@/lib/stellar'
import { resolveAssetMetadata } from '@/lib/assets'
import { getAssetPrices } from '@/lib/pricing'

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    // Find or create user
    let user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      include: { wallet: true },
    })

    if (!user) {
      const email = (claims as any).email || `${claims.userId}@privy.local`
      user = await prisma.user.create({
        data: { privyId: claims.userId, email },
        include: { wallet: true },
      })
    }

    if (!user.wallet) {
      return NextResponse.json({
        totalValue: 0,
        currency: 'USD',
        address: null,
        assets: []
      })
    }

    const balances = await getAccountBalance(user.wallet.address)

    // Enrich balances with metadata and price - BATCH FETCHING
    const assetsToFetch = balances.map(b => ({
      code: b.asset_code || 'XLM',
      issuer: b.asset_issuer
    }));

    // Fetch all prices in one go to avoid N+1
    const prices = await getAssetPrices(assetsToFetch);

    const assets = balances.map((b) => {
      const code = b.asset_code || 'XLM';
      const issuer = b.asset_issuer;
      const metadata = resolveAssetMetadata(code, issuer);
      // Use price from batch result, default to 0 if missing
      const priceData = prices[code] || { price: 0, currency: 'USD' };
      const balanceVal = parseFloat(b.balance);
      const value = balanceVal * priceData.price;

      return {
        code,
        issuer,
        balance: b.balance,
        value,
        price: priceData.price,
        metadata
      };
    });

    const totalValue = assets.reduce((acc, curr) => acc + curr.value, 0);

    // Legacy support for older clients/components if needed during migration
    // We can remove this once frontend is fully updated, but it helps prevent immediate crashes
    // if something assumes top-level keys.
    const usdcAsset = assets.find(a => a.code === 'USDC');
    const xlmAsset = assets.find(a => a.code === 'XLM');

    return NextResponse.json({
      totalValue,
      currency: 'USD',
      address: user.wallet.address,
      assets,
      // Legacy fields for backward compat
      usd: usdcAsset?.balance || '0',
      xlm: xlmAsset?.balance || '0',
    })
  } catch (error) {
    console.error('Balance GET error:', error)
    return NextResponse.json({ error: 'Failed to get balance' }, { status: 500 })
  }
}

