/**
 * Verification script for MoonPay webhook signature.
 * Run: npx tsx scripts/verify-moonpay-webhook.ts
 *
 * Tests:
 * 1. Valid signature + valid body → passes
 * 2. Valid signature + tampered body → rejected
 * 3. Wrong secret → rejected
 * 4. Missing/empty signature → rejected
 * 5. Missing/empty secret → rejected
 */

import crypto from 'crypto'

function verifyMoonPaySignature(rawBody: string, signature: string, secret: string): boolean {
  if (!signature || !secret) return false
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64')
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false // handles length mismatch
  }
}

const testSecret = 'wk_test_secret_123'
const payload = JSON.stringify({
  type: 'transaction_completed',
  data: { status: 'completed', externalTransactionId: 'INV-2025-001' },
})
const validSignature = crypto
  .createHmac('sha256', testSecret)
  .update(payload)
  .digest('base64')

type TestCase = { description: string; result: boolean; expected: boolean }

const tests: TestCase[] = [
  {
    description: 'Valid signature + valid body',
    result: verifyMoonPaySignature(payload, validSignature, testSecret),
    expected: true,
  },
  {
    description: 'Valid signature + tampered body',
    result: verifyMoonPaySignature(payload + 'x', validSignature, testSecret),
    expected: false,
  },
  {
    description: 'Correct body + wrong secret',
    result: verifyMoonPaySignature(payload, validSignature, 'wrong_secret'),
    expected: false,
  },
  {
    description: 'Correct body + empty signature',
    result: verifyMoonPaySignature(payload, '', testSecret),
    expected: false,
  },
  {
    description: 'Correct body + valid signature + empty secret',
    result: verifyMoonPaySignature(payload, validSignature, ''),
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
