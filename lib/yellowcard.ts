import axios from 'axios'

const yellowCardClient = axios.create({
  baseURL: process.env.YELLOWCARD_BASE_URL,
  headers: {
    Authorization: `Bearer ${process.env.YELLOWCARD_API_KEY}`,
    'Content-Type': 'application/json',
  },
})

export async function initiateWithdrawal({
  amount,
  reference,
  bankAccount,
}: {
  amount: number
  reference: string
  bankAccount: {
    accountNumber: string
    bankCode: string
    accountName: string
  }
}) {
  try {
    const { data } = await yellowCardClient.post('/withdrawals', {
      amount,
      sourceCurrency: 'USDC',
      destinationCurrency: 'NGN',
      payoutMethod: 'bank_transfer',
      bankAccount,
      reference,
    })

    return data
  } catch (error: any) {
    console.error('Yellow Card error:', error?.response?.data)
    throw new Error('YELLOWCARD_FAILED')
  }
}
