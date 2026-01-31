/**
 * Virtual Accounts Testing Script
 *
 * Run with: npx tsx scripts/test-virtual-accounts.ts
 * or: node scripts/test-virtual-accounts.js (if compiled)
 */

import { prisma } from "../lib/db";
import {
  createVirtualAccount,
  getVirtualAccountByUserId,
  getVirtualAccountByAccountNumber,
} from "../lib/virtual-accounts/service";
import { processDeposit } from "../lib/virtual-accounts/deposit-processor";
import { checkFundingWalletBalance } from "../lib/virtual-accounts/funding-wallet";
import { getVirtualAccountProvider } from "../lib/virtual-accounts/provider-factory";

async function main() {
  console.log("🧪 Virtual Accounts Testing Script\n");

  // Test 1: Check provider configuration
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Test 1: Provider Configuration");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  try {
    const provider = getVirtualAccountProvider();
    console.log("✅ Provider configured:", provider.name);
  } catch (error) {
    console.error("❌ Provider configuration failed:", error);
    process.exit(1);
  }

  // Test 2: Check funding wallet balance
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Test 2: Funding Wallet Balance");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  try {
    const balance = await checkFundingWalletBalance();
    console.log("✅ Funding wallet balance:", balance, "USDC");
    if (balance < 1000) {
      console.warn("⚠️  WARNING: Balance below recommended $1,000");
    }
  } catch (error) {
    console.error("❌ Failed to check funding wallet:", error);
  }

  // Test 3: Create virtual account for test user
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Test 3: Virtual Account Creation");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Find or create test user
  let testUser = await prisma.user.findFirst({
    where: { email: "test@lancepay.com" },
  });

  if (!testUser) {
    console.log("Creating test user...");
    testUser = await prisma.user.create({
      data: {
        privyId: "test_privy_" + Date.now(),
        email: "test@lancepay.com",
        name: "Test User",
      },
    });
    console.log("✅ Test user created:", testUser.id);

    // Create wallet for test user
    const { Keypair } = await import("@stellar/stellar-sdk");
    const keypair = Keypair.random();

    await prisma.wallet.create({
      data: {
        userId: testUser.id,
        address: keypair.publicKey(),
      },
    });
    console.log("✅ Test wallet created:", keypair.publicKey());
  }

  try {
    // Check if account already exists
    const existing = await getVirtualAccountByUserId(testUser.id);
    if (existing) {
      console.log("✅ Virtual account already exists:");
      console.log("   Bank:", existing.bankName);
      console.log("   Account Number:", existing.accountNumber);
      console.log("   Account Name:", existing.accountName);
      console.log("   Provider:", existing.provider);
    } else {
      console.log("Creating virtual account...");
      const account = await createVirtualAccount(testUser.id);
      console.log("✅ Virtual account created:");
      console.log("   Bank:", account.bankName);
      console.log("   Account Number:", account.accountNumber);
      console.log("   Account Name:", account.accountName);
      console.log("   Provider:", account.provider);
    }
  } catch (error) {
    console.error("❌ Virtual account creation failed:", error);
  }

  // Test 4: Test account lookup
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Test 4: Account Lookup");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  try {
    const account = await getVirtualAccountByUserId(testUser.id);
    if (account) {
      console.log("✅ Found by user ID:", account.accountNumber);

      const accountByNumber = await getVirtualAccountByAccountNumber(
        account.accountNumber,
      );
      if (accountByNumber) {
        console.log("✅ Found by account number:", accountByNumber.userId);
      } else {
        console.error("❌ Failed to find by account number");
      }
    } else {
      console.error("❌ No account found for user");
    }
  } catch (error) {
    console.error("❌ Account lookup failed:", error);
  }

  // Test 5: Simulate deposit processing
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Test 5: Deposit Processing (Simulation)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(
    "⚠️  NOTE: This is a DRY RUN - no actual USDC will be transferred",
  );

  const account = await getVirtualAccountByUserId(testUser.id);
  if (account) {
    const mockPayload = {
      accountNumber: account.accountNumber,
      amount: 5000, // NGN 5,000
      reference: "test_deposit_" + Date.now(),
      senderName: "Test Client",
      narration: "Test payment",
      paymentDate: new Date().toISOString(),
      currency: "NGN",
    };

    console.log("Mock deposit payload:");
    console.log("   Amount: ₦" + mockPayload.amount);
    console.log("   Account:", mockPayload.accountNumber);
    console.log("   Reference:", mockPayload.reference);

    console.log("\n⚠️  Skipping actual processing to avoid real USDC transfer");
    console.log("To test actual processing, uncomment the processDeposit call");

    // Uncomment to test actual processing (will transfer real USDC):
    // try {
    //   const result = await processDeposit(mockPayload)
    //   if (result.success) {
    //     console.log('✅ Deposit processed successfully:')
    //     console.log('   Transaction ID:', result.transactionId)
    //     console.log('   USDC Credited:', result.usdcCredited)
    //     console.log('   TX Hash:', result.txHash)
    //   } else {
    //     console.error('❌ Deposit processing failed:', result.error)
    //   }
    // } catch (error) {
    //   console.error('❌ Deposit processing error:', error)
    // }
  }

  // Summary
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Test Summary");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("✅ Tests completed");
  console.log("\nNext steps:");
  console.log("1. Test webhook endpoint with provider's sandbox");
  console.log("2. Send a real test deposit (small amount)");
  console.log("3. Monitor logs for webhook processing");
  console.log("4. Verify USDC credited to user wallet");

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
