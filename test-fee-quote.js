/**
 * Simple test script for the fee-quote API logic
 * Run with: node test-fee-quote.js
 */

const FEE_CONFIG = {
  onRamp: {
    percentageFee: 0.035, // 3.5%
    fixedFee: 0.50,
  },
  offRamp: {
    percentageFee: 0.015, // 1.5%
    fixedFee: 0.25,
  },
};

function calculateFees(usdAmount, exchangeRate, stellarBaseFee = 0.00001) {
  // Step 1: Calculate on-ramp fee
  const onRampFee = (usdAmount * FEE_CONFIG.onRamp.percentageFee) + FEE_CONFIG.onRamp.fixedFee;

  // Step 2: Network fee (Stellar)
  const networkFee = stellarBaseFee;

  // Step 3: Calculate net USDC after on-ramp and network fees
  const netUsdc = usdAmount - onRampFee - networkFee;

  // Step 4: Calculate off-ramp fee
  const offRampFee = (netUsdc * FEE_CONFIG.offRamp.percentageFee) + FEE_CONFIG.offRamp.fixedFee;

  // Step 5: Final USDC after all fees
  const finalUsdc = netUsdc - offRampFee;

  // Step 6: Convert to NGN
  const finalNgnValue = finalUsdc * exchangeRate;

  // Step 7: Calculate effective rate
  const effectiveRate = finalNgnValue / usdAmount;

  return {
    netUsdcValue: parseFloat(finalUsdc.toFixed(2)),
    finalNgnValue: parseFloat(finalNgnValue.toFixed(2)),
    feeBreakdown: {
      onRamp: parseFloat(onRampFee.toFixed(2)),
      network: parseFloat(networkFee.toFixed(2)),
      offRamp: parseFloat(offRampFee.toFixed(2)),
    },
    effectiveRate: parseFloat(effectiveRate.toFixed(2)),
  };
}

// Test scenarios
console.log("=== Fee Quote Calculator Tests ===\n");

// Test 1: Basic Quote for $100
console.log("Test 1: $100 USD");
const test1 = calculateFees(100, 1600);
console.log(JSON.stringify({
  usdAmount: 100.00,
  ...test1,
  timestamp: new Date().toISOString()
}, null, 2));
console.log(`\nVerification: ${test1.netUsdcValue} + ${test1.feeBreakdown.onRamp} + ${test1.feeBreakdown.network} + ${test1.feeBreakdown.offRamp} ≈ 100.00`);
const total = test1.netUsdcValue + test1.feeBreakdown.onRamp + test1.feeBreakdown.network + test1.feeBreakdown.offRamp;
console.log(`Total: ${total.toFixed(2)}\n`);

// Test 2: Large amount $10,000
console.log("\nTest 2: $10,000 USD");
const test2 = calculateFees(10000, 1600);
console.log(JSON.stringify({
  usdAmount: 10000.00,
  ...test2,
  timestamp: new Date().toISOString()
}, null, 2));

// Test 3: Small amount $10
console.log("\nTest 3: $10 USD (small amount)");
const test3 = calculateFees(10, 1600);
console.log(JSON.stringify({
  usdAmount: 10.00,
  ...test3,
  timestamp: new Date().toISOString()
}, null, 2));

// Test 4: Different exchange rate
console.log("\nTest 4: $100 USD with different exchange rate (1700 NGN/USD)");
const test4 = calculateFees(100, 1700);
console.log(JSON.stringify({
  usdAmount: 100.00,
  ...test4,
  timestamp: new Date().toISOString()
}, null, 2));

console.log("\n=== All Tests Complete ===");
