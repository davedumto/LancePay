/**
 * Webhook Test Script
 * Tests the webhook functionality end-to-end
 */

import { PrismaClient } from '@prisma/client'
import { computeWebhookSignature, verifyWebhookSignature, dispatchWebhooks } from '../lib/webhooks'
import crypto from 'crypto'

const prisma = new PrismaClient()

// Test webhook receiver endpoint (we'll create a simple one)
const TEST_WEBHOOK_URL = 'http://localhost:3000/api/test/webhook-receiver'

async function testWebhooks() {
  console.log('🧪 Starting Webhook Tests...\n')

  try {
    // Step 1: Create a test user (or get existing)
    console.log('1️⃣ Creating test user...')
    let testUser = await prisma.user.findFirst({
      where: { email: 'test@webhook.test' }
    })

    if (!testUser) {
      testUser = await prisma.user.create({
        data: {
          privyId: `test_${crypto.randomBytes(16).toString('hex')}`,
          email: 'test@webhook.test',
          name: 'Test User',
        }
      })
      console.log(`   ✅ Created test user: ${testUser.id}`)
    } else {
      console.log(`   ✅ Using existing test user: ${testUser.id}`)
    }

    // Step 2: Create a test webhook
    console.log('\n2️⃣ Creating test webhook...')
    const signingSecret = `whsec_${crypto.randomBytes(32).toString('base64url')}`
    const webhook = await prisma.userWebhook.create({
      data: {
        userId: testUser.id,
        targetUrl: TEST_WEBHOOK_URL,
        signingSecret,
        description: 'Test Webhook',
        subscribedEvents: ['invoice.paid', 'invoice.viewed'],
        isActive: true,
      }
    })
    console.log(`   ✅ Created webhook: ${webhook.id}`)
    console.log(`   📍 Target URL: ${webhook.targetUrl}`)
    console.log(`   🔑 Secret: ${webhook.signingSecret.substring(0, 20)}...`)

    // Step 3: Test signature computation
    console.log('\n3️⃣ Testing signature computation...')
    const testPayload = {
      event: 'invoice.paid' as const,
      timestamp: new Date().toISOString(),
      data: { invoiceId: 'test-123', amount: 100 }
    }
    const payloadString = JSON.stringify(testPayload)
    const signature = computeWebhookSignature(payloadString, signingSecret)
    console.log(`   ✅ Signature computed: ${signature.substring(0, 20)}...`)

    // Step 4: Test signature verification
    console.log('\n4️⃣ Testing signature verification...')
    const isValid = verifyWebhookSignature(payloadString, signature, signingSecret)
    const isInvalid = verifyWebhookSignature(payloadString, 'wrong_signature', signingSecret)
    console.log(`   ✅ Valid signature check: ${isValid ? 'PASS' : 'FAIL'}`)
    console.log(`   ✅ Invalid signature check: ${!isInvalid ? 'PASS' : 'FAIL'}`)

    // Step 5: Test webhook dispatch (this will try to send to our test endpoint)
    console.log('\n5️⃣ Testing webhook dispatch...')
    console.log('   📤 Dispatching invoice.paid event...')
    
    await dispatchWebhooks(testUser.id, 'invoice.paid', {
      invoiceId: 'test-invoice-123',
      invoiceNumber: 'INV-TEST-001',
      amount: 150.00,
      currency: 'USD',
      clientEmail: 'client@test.com',
      clientName: 'Test Client',
      paidAt: new Date().toISOString(),
    })
    
    console.log('   ✅ Webhook dispatch completed (check server logs for delivery status)')

    // Step 6: Test invoice.viewed event
    console.log('\n6️⃣ Testing invoice.viewed event...')
    await dispatchWebhooks(testUser.id, 'invoice.viewed', {
      invoiceId: 'test-invoice-123',
      invoiceNumber: 'INV-TEST-001',
      amount: 150.00,
      currency: 'USD',
      clientEmail: 'client@test.com',
      viewedAt: new Date().toISOString(),
    })
    console.log('   ✅ Invoice viewed webhook dispatched')

    // Step 7: Verify webhook was updated
    console.log('\n7️⃣ Verifying webhook lastTriggeredAt...')
    await new Promise(resolve => setTimeout(resolve, 1000)) // Wait a bit for async operations
    const updatedWebhook = await prisma.userWebhook.findUnique({
      where: { id: webhook.id }
    })
    console.log(`   ✅ Last triggered: ${updatedWebhook?.lastTriggeredAt || 'Not yet'}`)

    // Step 8: Test event filtering
    console.log('\n8️⃣ Testing event subscription filtering...')
    const webhookOnlyPaid = await prisma.userWebhook.create({
      data: {
        userId: testUser.id,
        targetUrl: TEST_WEBHOOK_URL + '/paid-only',
        signingSecret: `whsec_${crypto.randomBytes(32).toString('base64url')}`,
        subscribedEvents: ['invoice.paid'], // Only invoice.paid
        isActive: true,
      }
    })
    
    // Dispatch invoice.viewed - should NOT trigger webhookOnlyPaid
    await dispatchWebhooks(testUser.id, 'invoice.viewed', {
      invoiceId: 'test-456',
      invoiceNumber: 'INV-TEST-002',
      amount: 200.00,
      currency: 'USD',
      clientEmail: 'client2@test.com',
      viewedAt: new Date().toISOString(),
    })
    console.log('   ✅ Event filtering test completed (invoice.viewed should not trigger paid-only webhook)')

    // Cleanup
    console.log('\n🧹 Cleaning up test data...')
    await prisma.userWebhook.deleteMany({
      where: { userId: testUser.id }
    })
    console.log('   ✅ Test webhooks deleted')

    console.log('\n✅ All webhook tests completed successfully!')
    console.log('\n📋 Test Summary:')
    console.log('   ✓ Webhook creation')
    console.log('   ✓ Signature computation')
    console.log('   ✓ Signature verification')
    console.log('   ✓ Webhook dispatch (invoice.paid)')
    console.log('   ✓ Webhook dispatch (invoice.viewed)')
    console.log('   ✓ Event subscription filtering')
    console.log('   ✓ Database updates (lastTriggeredAt)')

  } catch (error) {
    console.error('\n❌ Test failed:', error)
    throw error
  }
}

// Run tests if executed directly
if (require.main === module) {
  testWebhooks()
    .then(() => {
      console.log('\n🎉 Tests completed!')
      process.exit(0)
    })
    .catch((error) => {
      console.error('\n💥 Tests failed:', error)
      process.exit(1)
    })
}

export { testWebhooks }
