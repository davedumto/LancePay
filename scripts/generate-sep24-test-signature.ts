import crypto from 'crypto'

const payload = {
  id: 'test_withdrawal_123',
  status: 'completed',
  timestamp: Date.now(),
}

const serializedPayload = JSON.stringify(payload)
const secret = process.env.YELLOW_CARD_WEBHOOK_SECRET

if (!secret) {
  throw new Error('YELLOW_CARD_WEBHOOK_SECRET must be set')
}

const signature = crypto
  .createHmac('sha256', secret)
  .update(serializedPayload)
  .digest('hex')

console.log('Payload:', serializedPayload)
console.log('Signature:', signature)
console.log('\nTest command:')
console.log(`curl -X POST http://localhost:3000/api/webhooks/sep24?anchor=yellow-card \\
  -H "X-SEP24-Signature: ${signature}" \\
  -H "Content-Type: application/json" \\
  -d '${serializedPayload}'`)
