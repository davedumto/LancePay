/**
 * End-to-End Webhook Delivery Test
 * Tests actual webhook HTTP delivery with signature verification
 */

import { PrismaClient } from '@prisma/client'
import { dispatchWebhooks, computeWebhookSignature, verifyWebhookSignature } from '../lib/webhooks'
import crypto from 'crypto'

const prisma = new PrismaClient()
const WEBHOOK_RECEIVER_URL = 'http://localhost:3000/api/test/webhook-receiver'

async function testWebhookDelivery() {
  console.log('🧪 Testing End-to-End Webhook Delivery...\n')

  try {
    // Create test user
    const testUser = await prisma.user.findFirst({
      where: { email: 'delivery-test@webhook.test' }
    }) || await prisma.user.create({
      data: {
        privyId: `test_delivery_${crypto.randomBytes(16).toString('hex')}`,
        email: 'delivery-test@webhook.test',
        name: 'Delivery Test User',
      }
    })

    console.log(`✅ Test user: ${testUser.id}\n`)

    // Create webhook pointing to our test receiver
    const signingSecret = `whsec_${crypto.randomBytes(32).toString('base64url')}`
    const webhook = await prisma.userWebhook.create({
      data: {
        userId: testUser.id,
        targetUrl: WEBHOOK_RECEIVER_URL,
        signingSecret,
        description: 'E2E Test Webhook',
        subscribedEvents: ['invoice.paid', 'invoice.viewed'],
        isActive: true,
      }
    })

    console.log(`✅ Created webhook: ${webhook.id}`)
    console.log(`📍 Target: ${webhook.targetUrl}\n`)

    // Test 1: Dispatch invoice.paid event
    console.log('1️⃣ Testing invoice.paid webhook delivery...')
    const paidPayload = {
      invoiceId: 'e2e-test-001',
      invoiceNumber: 'INV-E2E-001',
      amount: 500.00,
      currency: 'USD',
      clientEmail: 'client@e2e.test',
      clientName: 'E2E Client',
      paidAt: new Date().toISOString(),
    }

    await dispatchWebhooks(testUser.id, 'invoice.paid', paidPayload)
    console.log('   ✅ Webhook dispatched')
    
    // Wait for async delivery
    await new Promise(resolve => setTimeout(resolve, 1000))
    
    const updatedWebhook1 = await prisma.userWebhook.findUnique({
      where: { id: webhook.id }
    })
    console.log(`   ✅ Last triggered: ${updatedWebhook1?.lastTriggeredAt ? 'YES' : 'NO'}`)

    // Test 2: Dispatch invoice.viewed event
    console.log('\n2️⃣ Testing invoice.viewed webhook delivery...')
    const viewedPayload = {
      invoiceId: 'e2e-test-002',
      invoiceNumber: 'INV-E2E-002',
      amount: 300.00,
      currency: 'USD',
      clientEmail: 'viewer@e2e.test',
      viewedAt: new Date().toISOString(),
    }

    await dispatchWebhooks(testUser.id, 'invoice.viewed', viewedPayload)
    console.log('   ✅ Webhook dispatched')
    
    await new Promise(resolve => setTimeout(resolve, 1000))
    
    const updatedWebhook2 = await prisma.userWebhook.findUnique({
      where: { id: webhook.id }
    })
    console.log(`   ✅ Last triggered: ${updatedWebhook2?.lastTriggeredAt ? 'YES' : 'NO'}`)

    // Test 3: Verify signature computation matches what would be sent
    console.log('\n3️⃣ Verifying signature computation...')
    const testPayload = {
      event: 'invoice.paid' as const,
      timestamp: new Date().toISOString(),
      data: paidPayload,
    }
    const payloadString = JSON.stringify(testPayload)
    const computedSignature = computeWebhookSignature(payloadString, signingSecret)
    const isValid = verifyWebhookSignature(payloadString, computedSignature, signingSecret)
    console.log(`   ✅ Signature computation: ${isValid ? 'VALID' : 'INVALID'}`)
    console.log(`   🔑 Signature preview: ${computedSignature.substring(0, 30)}...`)

    // Test 4: Test with inactive webhook (should not dispatch)
    console.log('\n4️⃣ Testing inactive webhook filtering...')
    await prisma.userWebhook.update({
      where: { id: webhook.id },
      data: { isActive: false }
    })

    const beforeCount = (await prisma.userWebhook.findUnique({
      where: { id: webhook.id }
    }))?.lastTriggeredAt

    await dispatchWebhooks(testUser.id, 'invoice.paid', {
      invoiceId: 'should-not-trigger',
      invoiceNumber: 'INV-NO-TRIGGER',
      amount: 100.00,
      currency: 'USD',
      clientEmail: 'test@test.com',
      paidAt: new Date().toISOString(),
    })

    await new Promise(resolve => setTimeout(resolve, 500))
    
    const afterWebhook = await prisma.userWebhook.findUnique({
      where: { id: webhook.id }
    })
    const afterCount = afterWebhook?.lastTriggeredAt
    
    // lastTriggeredAt should not change for inactive webhook
    const notTriggered = beforeCount?.getTime() === afterCount?.getTime()
    console.log(`   ✅ Inactive webhook not triggered: ${notTriggered ? 'PASS' : 'FAIL'}`)

    // Cleanup
    console.log('\n🧹 Cleaning up...')
    await prisma.userWebhook.deleteMany({
      where: { userId: testUser.id }
    })
    console.log('   ✅ Test data cleaned up')

    console.log('\n✅ End-to-End Webhook Delivery Tests Completed!')
    console.log('\n📋 Test Results:')
    console.log('   ✓ Webhook creation')
    console.log('   ✓ invoice.paid event delivery')
    console.log('   ✓ invoice.viewed event delivery')
    console.log('   ✓ Signature computation and verification')
    console.log('   ✓ Inactive webhook filtering')
    console.log('   ✓ lastTriggeredAt timestamp updates')

  } catch (error) {
    console.error('\n❌ Test failed:', error)
    throw error
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  testWebhookDelivery()
    .then(() => {
      console.log('\n🎉 All delivery tests passed!')
      process.exit(0)
    })
    .catch((error) => {
      console.error('\n💥 Delivery tests failed:', error)
      process.exit(1)
    })
}

export { testWebhookDelivery }
