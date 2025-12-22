import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function POST(request: NextRequest) {
  try {
    const body = await request.text()
    const event = JSON.parse(body)
    
    console.log('Privy webhook received:', event.type)
    
    // Handle user.created event
    if (event.type === 'user.created') {
      const privyId = event.data?.id
      const email = event.data?.email?.address || ''
      const linkedAccounts = event.data?.linked_accounts || []
      
      console.log('User created event - privyId:', privyId, 'linked_accounts:', JSON.stringify(linkedAccounts))
      
      // Find embedded wallet - check both camelCase and snake_case field names
      const embeddedWallet = linkedAccounts.find(
        (account: any) => 
          account.type === 'wallet' && 
          (account.wallet_client_type === 'privy' || account.walletClientType === 'privy')
      )
      
      const walletAddress = embeddedWallet?.address
      console.log('Found embedded wallet:', walletAddress || 'none')
      
      await prisma.user.upsert({
        where: { privyId },
        update: walletAddress ? {
          wallet: {
            upsert: {
              create: { address: walletAddress },
              update: { address: walletAddress }
            }
          }
        } : {},
        create: {
          privyId,
          email,
          wallet: walletAddress ? { create: { address: walletAddress } } : undefined,
        },
      })
      
      console.log('User upserted successfully:', privyId)
    }
    
    // Handle user.linked_account event (wallet created after signup)
    if (event.type === 'user.linked_account') {
      const privyId = event.data?.id
      const linkedAccount = event.data?.linked_account
      
      console.log('Linked account event - privyId:', privyId, 'account:', JSON.stringify(linkedAccount))
      
      const isEmbeddedWallet = linkedAccount?.type === 'wallet' && 
        (linkedAccount?.wallet_client_type === 'privy' || linkedAccount?.walletClientType === 'privy')
      
      if (isEmbeddedWallet && linkedAccount?.address) {
        const user = await prisma.user.findUnique({ 
          where: { privyId },
          include: { wallet: true }
        })
        
        if (user && !user.wallet) {
          await prisma.wallet.create({
            data: {
              userId: user.id,
              address: linkedAccount.address,
            }
          })
          console.log('Wallet added for existing user:', privyId)
        }
      }
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error('Privy webhook error:', error)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}
