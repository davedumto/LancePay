import crypto from 'crypto'

/**
 * Initiates an off-ramp withdrawal through the custom off-ramp API.
 * Signs the request using the API key and secret.
 */
export async function initiateOfframp(params: {
  amount: number          // USDC amount
  reference: string       // unique withdrawal ID
  bankAccount: {
    accountNumber: string
    bankCode: string
    accountName: string
  }
}): Promise<{ transactionId: string; status: string }> {
  const apiKey = process.env.OFFRAMP_API_KEY
  const apiSecret = process.env.OFFRAMP_API_SECRET
  const apiUrl = process.env.OFFRAMP_API_URL

  if (!apiKey || !apiSecret || !apiUrl) {
    throw new Error('Off-ramp API configuration missing')
  }

  const payload = JSON.stringify(params)
  const timestamp = Date.now().toString()
  
  // Standard HMAC-SHA256 signature for security
  // We sign (timestamp + body) to prevent replay attacks if the API checks the timestamp
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(timestamp + payload)
    .digest('hex')

  const response = await fetch(`${apiUrl}/withdrawals`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Offramp-API-Key': apiKey,
      'X-Offramp-Timestamp': timestamp,
      'X-Offramp-Signature': signature,
    },
    body: payload,
  })

  const responseData = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(responseData.error || responseData.message || 'Off-ramp API error')
  }

  return {
    transactionId: responseData.transactionId,
    status: responseData.status || 'pending',
  }
}
