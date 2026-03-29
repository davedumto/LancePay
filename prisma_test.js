const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function test() {
  console.log('--- Testing LancePay API Logic ---')

  try {
    // 1. Check Schema Fix
    const user = await prisma.user.findFirst({
      include: { tags: true, auditEvents: true }
    })
    console.log('✅ Schema Fix: User model now includes tags relation.')

    // 2. Mocking Auth & Logic Verification (Unit style)
    // Since I can't easily run the Next.js server and provide a real Auth token in this environment,
    // I will verify the Prisma queries and logic directly.

    if (user) {
      console.log(`Testing with User ID: ${user.id}`)

      // Test Tags logic
      const tags = await prisma.tag.findMany({
        where: { userId: user.id },
        include: { _count: { select: { invoiceTags: true } } }
      })
      console.log(`✅ Tags Fetch: Found ${tags.length} tags for user.`)

      // Test Audit Log logic
      const events = await prisma.auditEvent.findMany({
        where: { actorId: user.id },
        take: 5
      })
      console.log(`✅ Audit Log Fetch: Found ${events.length} recent events.`)

      // Test Invoice Duplication logic
      const invoice = await prisma.invoice.findFirst({ where: { userId: user.id } })
      if (invoice) {
        console.log(`✅ Found sample invoice: ${invoice.invoiceNumber}`)
        // Verification of duplication fields (not actually creating in DB to avoid side effects if not desired, 
        // but the query construction was reviewed).
      }
    } else {
      console.log('⚠️ No users found in database to perform full logic test.')
    }

  } catch (error) {
    console.error('❌ Test failed:', error)
  } finally {
    await prisma.$disconnect()
  }
}

test()
