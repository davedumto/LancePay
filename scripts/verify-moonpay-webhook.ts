/**
 * Verification script for MoonPay webhook signature.
 * Run: npx tsx scripts/verify-moonpay-webhook.ts
 *
 * Tests:
 * 1. Valid Moonpay-Signature-V2 + valid body → passes
 * 2. Valid signature + tampered body → rejected
 * 3. Wrong secret → rejected
 * 4. Stale timestamp → rejected
 * 5. Missing/empty signature → rejected
 * 6. Missing/empty secret → rejected
 */

import { signMoonPayWebhook, verifyMoonPaySignatureV2 } from '../lib/moonpay-signature'

const testSecret = 'wk_test_secret_123'
const payload = JSON.stringify({
  type: 'transaction_completed',
  data: { status: 'completed', externalTransactionId: 'INV-2025-001' },
})
const now = Math.floor(Date.now() / 1000)
const validSignature = signMoonPayWebhook(payload, now, testSecret)

type TestCase = { description: string; result: boolean; expected: boolean }

const tests: TestCase[] = [
  {
    description: 'Valid signature + valid body',
    result: verifyMoonPaySignatureV2(payload, validSignature, testSecret),
    expected: true,
  },
  {
    description: 'Valid signature + tampered body',
    result: verifyMoonPaySignatureV2(payload + 'x', validSignature, testSecret),
    expected: false,
  },
  {
    description: 'Correct body + wrong secret',
    result: verifyMoonPaySignatureV2(payload, validSignature, 'wrong_secret'),
    expected: false,
  },
  {
    description: 'Correct body + stale timestamp',
    result: verifyMoonPaySignatureV2(payload, signMoonPayWebhook(payload, now - 3600, testSecret), testSecret),
    expected: false,
  },
  {
    description: 'Correct body + empty signature',
    result: verifyMoonPaySignatureV2(payload, '', testSecret),
    expected: false,
  },
  {
    description: 'Correct body + valid signature + empty secret',
    result: verifyMoonPaySignatureV2(payload, validSignature, ''),
    expected: false,
  },
]

let passed = 0
for (const test of tests) {
  const ok = test.result === test.expected
  if (ok) {
    console.log(`✅ PASS: ${test.description}`)
    passed++
  } else {
    console.log(`❌ FAIL: ${test.description}`)
  }
}

console.log(`\n${passed}/${tests.length} tests passed`)
process.exit(passed === tests.length ? 0 : 1)
