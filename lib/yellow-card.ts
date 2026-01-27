export interface YellowCardWithdrawalRequest {
  amount: number // NGN amount
  bankAccountId: string
  accountNumber: string
  bankCode: string
  recipientName: string
  recipientEmail: string
  reference: string // Our internal transaction/advance ID
}

export interface YellowCardWithdrawalResponse {
  success: boolean
  transactionId?: string
  error?: string
  status?: 'pending' | 'processing' | 'completed' | 'failed'
}

/**
 * Initiate Yellow Card NGN withdrawal
 * This replaces the placeholder in /lib/auto-swap.ts
 */
export async function initiateYellowCardWithdrawal(
  params: YellowCardWithdrawalRequest
): Promise<YellowCardWithdrawalResponse> {
  try {
    const apiKey = process.env.YELLOW_CARD_API_KEY
    const apiSecret = process.env.YELLOW_CARD_SECRET

    if (!apiKey || !apiSecret) {
      console.error('Yellow Card API credentials not configured')
      return {
        success: false,
        error: 'Yellow Card service not configured',
        status: 'failed',
      }
    }

    // Yellow Card API endpoint (adjust based on actual API documentation)
    const endpoint =
      process.env.YELLOW_CARD_API_URL || 'https://api.yellowcard.io/v1'

    const response = await fetch(`${endpoint}/withdrawals`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-YC-Secret': apiSecret,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        currency: 'NGN',
        amount: params.amount,
        recipient: {
          bank_code: params.bankCode,
          account_number: params.accountNumber,
          account_name: params.recipientName,
        },
        metadata: {
          email: params.recipientEmail,
          reference: params.reference,
        },
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      console.error('Yellow Card API error:', errorData)

      return {
        success: false,
        error: errorData.message || 'Yellow Card withdrawal failed',
        status: 'failed',
      }
    }

    const data = await response.json()

    return {
      success: true,
      transactionId: data.transaction_id || data.id,
      status: 'processing',
    }
  } catch (error) {
    console.error('Yellow Card withdrawal error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      status: 'failed',
    }
  }
}

/**
 * Check Yellow Card transaction status
 */
export async function checkYellowCardStatus(
  transactionId: string
): Promise<{ status: string; error?: string }> {
  try {
    const apiKey = process.env.YELLOW_CARD_API_KEY
    const endpoint =
      process.env.YELLOW_CARD_API_URL || 'https://api.yellowcard.io/v1'

    const response = await fetch(`${endpoint}/withdrawals/${transactionId}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      return { status: 'unknown', error: 'Failed to check status' }
    }

    const data = await response.json()
    return { status: data.status || 'unknown' }
  } catch (error) {
    console.error('Yellow Card status check error:', error)
    return { status: 'unknown', error: 'Status check failed' }
  }
}
