/**
 * Simple test script for the P&L API logic
 * Run with: node test-p-and-l.js
 */

const PLATFORM_FEE_RATE = 0.005; // 0.5%
const WITHDRAWAL_FEE_RATE = 0.005; // 0.5%

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function computePlatformFee(amount) {
  return round2(amount * PLATFORM_FEE_RATE);
}

function computeWithdrawalFee(amount) {
  return round2(amount * WITHDRAWAL_FEE_RATE);
}

function calculateProfitAndLoss(incomeTransactions, withdrawalTransactions) {
  // Calculate gross income
  const totalIncome = round2(
    incomeTransactions.reduce((sum, t) => sum + t.amount, 0)
  );

  // Calculate platform fees (0.5% of each income transaction)
  const platformFees = round2(
    incomeTransactions.reduce((sum, t) => sum + computePlatformFee(t.amount), 0)
  );

  // Calculate withdrawal fees (0.5% of each withdrawal)
  const withdrawalFees = round2(
    withdrawalTransactions.reduce((sum, t) => sum + computeWithdrawalFee(t.amount), 0)
  );

  // Calculate operating expenses (total withdrawal amounts)
  const operatingExpenses = round2(
    withdrawalTransactions.reduce((sum, t) => sum + t.amount, 0)
  );

  // Calculate net profit
  const netProfit = round2(totalIncome - platformFees - withdrawalFees - operatingExpenses);

  return {
    totalIncome,
    platformFees,
    withdrawalFees,
    operatingExpenses,
    netProfit,
  };
}

// Test scenarios
console.log("=== P&L Calculator Tests ===\n");

// Test 1: Typical Month
console.log("Test 1: Typical Freelancer Month");
const test1Income = [
  { amount: 500, client: "Client A" },
  { amount: 1000, client: "Client B" },
  { amount: 750, client: "Client C" },
  { amount: 250, client: "Client A" },
];
const test1Withdrawals = [
  { amount: 1000 }, // Withdrew $1000 to bank
];
const test1Result = calculateProfitAndLoss(test1Income, test1Withdrawals);
console.log("Income transactions:", test1Income);
console.log("Withdrawal transactions:", test1Withdrawals);
console.log("\nP&L Summary:");
console.log(JSON.stringify(test1Result, null, 2));
console.log(`\nVerification:`);
console.log(`  Revenue: $${test1Result.totalIncome}`);
console.log(`  Less Platform Fees (0.5%): -$${test1Result.platformFees}`);
console.log(`  Less Withdrawal Fees (0.5%): -$${test1Result.withdrawalFees}`);
console.log(`  Less Operating Expenses: -$${test1Result.operatingExpenses}`);
console.log(`  = Net Profit: $${test1Result.netProfit}`);

// Test 2: High Volume Month
console.log("\n\nTest 2: High Volume Month");
const test2Income = Array(50).fill(null).map((_, i) => ({
  amount: 100 + (i * 10),
  client: `Client ${i % 10}`
}));
const test2Withdrawals = [
  { amount: 15000 },
  { amount: 10000 },
];
const test2Result = calculateProfitAndLoss(test2Income, test2Withdrawals);
console.log(`50 income transactions totaling: $${test2Result.totalIncome}`);
console.log(`2 withdrawals totaling: $${test2Result.operatingExpenses}`);
console.log("\nP&L Summary:");
console.log(JSON.stringify(test2Result, null, 2));

// Test 3: No Activity Period
console.log("\n\nTest 3: No Activity Period (Empty Month)");
const test3Income = [];
const test3Withdrawals = [];
const test3Result = calculateProfitAndLoss(test3Income, test3Withdrawals);
console.log("Income transactions: []");
console.log("Withdrawal transactions: []");
console.log("\nP&L Summary:");
console.log(JSON.stringify(test3Result, null, 2));
console.log("✓ All values should be 0.00");

// Test 4: Fee Accuracy Test
console.log("\n\nTest 4: Fee Accuracy Test");
console.log("For $1000 income:");
console.log(`  Platform fee (0.5%): $${computePlatformFee(1000)}`);
console.log(`For $500 withdrawal:`);
console.log(`  Withdrawal fee (0.5%): $${computeWithdrawalFee(500)}`);
console.log("\nFee calculation verification:");
const expectedPlatformFee = 1000 * 0.005;
const actualPlatformFee = computePlatformFee(1000);
console.log(`  Expected: $${expectedPlatformFee}, Actual: $${actualPlatformFee}`);
console.log(`  Match: ${expectedPlatformFee === actualPlatformFee ? '✓' : '✗'}`);

// Test 5: Negative Profit Scenario
console.log("\n\nTest 5: Negative Profit (Withdrawals exceed income)");
const test5Income = [
  { amount: 1000, client: "Client A" },
];
const test5Withdrawals = [
  { amount: 2000 }, // Withdrew more than earned
];
const test5Result = calculateProfitAndLoss(test5Income, test5Withdrawals);
console.log("Income: $1000");
console.log("Withdrawals: $2000");
console.log("\nP&L Summary:");
console.log(JSON.stringify(test5Result, null, 2));
console.log(`Net Profit is ${test5Result.netProfit < 0 ? 'NEGATIVE' : 'POSITIVE'}: $${test5Result.netProfit}`);

console.log("\n=== All Tests Complete ===");
