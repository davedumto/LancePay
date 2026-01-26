'use client'

import { useCallback } from 'react'

interface MoonPayWidgetProps {
  walletAddress: string
  amount: number
  currencyCode?: string
  invoiceId?: string
}

export function useMoonPayWidget() {
  const openWidget = useCallback(async ({
    walletAddress,
    amount,
    currencyCode = 'usdc_xlm',
    invoiceId
  }: MoonPayWidgetProps) => {
    const { loadMoonPay } = await import('@moonpay/moonpay-js')
    
    const moonPay = await loadMoonPay()
    if (!moonPay) throw new Error('Failed to load MoonPay')
    
    const sdk = moonPay({
      flow: 'buy',
      environment: 'sandbox', // Change to 'production' for live
      variant: 'overlay',
      params: {
        apiKey: process.env.NEXT_PUBLIC_MOONPAY_API_KEY!,
        theme: 'dark',
        baseCurrencyCode: 'usd',
        baseCurrencyAmount: String(amount),
        defaultCurrencyCode: currencyCode,
        walletAddress: walletAddress,
        externalTransactionId: invoiceId,
      }
    })
    
    if (sdk) sdk.show()
    return sdk
  }, [])

  return { openWidget }
}
