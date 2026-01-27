# Fee Quote API - Implementation Documentation

## Overview
The Fee Quote API provides real-time transparency for cross-border payment costs, giving freelancers a complete breakdown of fees from USD card payments to NGN bank deposits.

## Endpoint

```
GET /api/routes-d/utils/fee-quote?amount={usd_amount}
```

## Implementation Details

### Flow Diagram
```
USD (Card) 
  ↓
  → On-ramp Fee (MoonPay/Transak: 3.5% + $0.50)
  ↓
USDC (Stellar Network)
  ↓
  → Network Fee (Stellar: ~$0.00001)
  ↓
USDC (Ready for off-ramp)
  ↓
  → Off-ramp Fee (Yellow Card: 1.5% + $0.25)
  ↓
NGN (Bank Account)
```

### Fee Configuration

**On-ramp Fees (MoonPay/Transak):**
- Percentage: 3.5%
- Fixed Fee: $0.50
- Total: `(amount * 0.035) + 0.50`

**Network Fees (Stellar):**
- Dynamic fee fetched from Stellar network
- Typically ~$0.00001 (negligible)
- Converted from stroops to USD

**Off-ramp Fees (Yellow Card):**
- Percentage: 1.5%
- Fixed Fee: $0.25 (in USDC)
- Total: `(netUsdc * 0.015) + 0.25`

### Calculation Formula

```
1. On-ramp Fee = (USD Amount × 3.5%) + $0.50
2. Network Fee = Stellar Base Fee (dynamic, ~$0.00001)
3. Net USDC = USD Amount - On-ramp Fee - Network Fee
4. Off-ramp Fee = (Net USDC × 1.5%) + $0.25
5. Final USDC = Net USDC - Off-ramp Fee
6. Final NGN = Final USDC × Exchange Rate
7. Effective Rate = Final NGN ÷ Original USD Amount
```

### Caching Strategy

- **Exchange rates**: Cached for 60 seconds
- **Stellar network fees**: Cached for 60 seconds
- **Benefits**: 
  - Reduces API calls to external providers
  - Improves response time
  - Prevents rate limiting

### Response Format

```json
{
  "usdAmount": 100.00,
  "netUsdcValue": 94.31,
  "finalNgnValue": 150895.98,
  "feeBreakdown": {
    "onRamp": 4.00,
    "network": 0.00,
    "offRamp": 1.69
  },
  "effectiveRate": 1508.96,
  "timestamp": "2026-01-24T01:00:00Z"
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `usdAmount` | number | Original USD amount requested |
| `netUsdcValue` | number | Final USDC after all fees (before NGN conversion) |
| `finalNgnValue` | number | Final NGN amount recipient receives |
| `feeBreakdown.onRamp` | number | Fee charged by MoonPay/Transak (USD) |
| `feeBreakdown.network` | number | Stellar network transaction fee (USD) |
| `feeBreakdown.offRamp` | number | Fee charged by Yellow Card (USDC) |
| `effectiveRate` | number | NGN received per USD sent (after all fees) |
| `timestamp` | string | ISO 8601 timestamp of calculation |

## API Integration

### Example Requests

**Basic Quote:**
```bash
curl "http://localhost:3000/api/routes-d/utils/fee-quote?amount=100"
```

**Large Amount:**
```bash
curl "http://localhost:3000/api/routes-d/utils/fee-quote?amount=10000"
```

### Example Responses

**Success (200):**
```json
{
  "usdAmount": 100.00,
  "netUsdcValue": 94.31,
  "finalNgnValue": 150895.98,
  "feeBreakdown": {
    "onRamp": 4.00,
    "network": 0.00,
    "offRamp": 1.69
  },
  "effectiveRate": 1508.96,
  "timestamp": "2026-01-24T05:07:38.421Z"
}
```

**Missing Amount (400):**
```json
{
  "error": "Missing required parameter: amount"
}
```

**Invalid Amount (400):**
```json
{
  "error": "Amount must be a positive number"
}
```

**Server Error (500):**
```json
{
  "error": "Failed to calculate fee quote. Please try again later."
}
```

## Testing Checklist

### ✅ Functional Tests

1. **Basic Quote Test**
   - Request: `?amount=100`
   - Verify: All fees add up to original amount
   - Expected: `netUsdcValue + onRamp + network + offRamp ≈ 100`

2. **Zero/Negative Amount Test**
   - Request: `?amount=0` or `?amount=-10`
   - Expected: 400 error with message

3. **Missing Parameter Test**
   - Request: `/fee-quote` (no amount)
   - Expected: 400 error with message

4. **Large Amount Test**
   - Request: `?amount=10000`
   - Verify: Fees scale correctly
   - Check: Percentage fees are proportional

5. **Rate Volatility Test**
   - Make two requests 60+ seconds apart
   - Verify: `finalNgnValue` updates with new exchange rate
   - Check: `timestamp` changes

6. **Decimal Precision Test**
   - Request: `?amount=99.99`
   - Verify: No rounding errors
   - Check: All calculations to 2 decimal places

### ✅ Performance Tests

1. **Cache Validation**
   - Make multiple requests within 60 seconds
   - Verify: Fast response times (cached data)

2. **Cache Expiry**
   - Wait 60+ seconds, make new request
   - Verify: Fresh data fetched, new timestamp

### ✅ Integration Tests

1. **Exchange Rate Integration**
   - Verify: Uses `lib/exchange-rate.ts`
   - Check: Fallback rate works when API unavailable

2. **Stellar Network Integration**
   - Verify: Fetches real base fee from Stellar
   - Check: Proper conversion from stroops to USD

## Example Test Results

```
Test 1: $100 USD
- USD Amount: $100.00
- On-ramp Fee: $4.00 (3.5% + $0.50)
- Network Fee: $0.00 (negligible)
- Off-ramp Fee: $1.69 (1.5% of $95.50 + $0.25)
- Net USDC: $94.31
- Final NGN: ₦150,895.98
- Effective Rate: ₦1,508.96 per USD

Test 2: $10,000 USD
- USD Amount: $10,000.00
- On-ramp Fee: $350.50
- Network Fee: $0.00
- Off-ramp Fee: $144.99
- Net USDC: $9,504.51
- Final NGN: ₦15,207,211.98
- Effective Rate: ₦1,520.72 per USD
```

## Notes for Frontend Integration

### Display Example

```typescript
const response = await fetch(`/api/routes-d/utils/fee-quote?amount=${amount}`);
const quote = await response.json();

// Display to user:
console.log(`You send: $${quote.usdAmount}`);
console.log(`Recipient receives: ₦${quote.finalNgnValue.toLocaleString()}`);
console.log(`Total fees: $${(quote.feeBreakdown.onRamp + quote.feeBreakdown.network + quote.feeBreakdown.offRamp).toFixed(2)}`);
console.log(`Effective rate: ₦${quote.effectiveRate} per $1 USD`);
```

### User-Facing Fee Breakdown

```
Your Payment Breakdown:
━━━━━━━━━━━━━━━━━━━━━━━
You send:              $100.00 USD
━━━━━━━━━━━━━━━━━━━━━━━

Fees:
  Card → USDC           -$4.00
  Network               -$0.00
  USDC → NGN            -$1.69
                       ━━━━━━
  Total fees:           -$5.69

━━━━━━━━━━━━━━━━━━━━━━━
Recipient receives:   ₦150,896
━━━━━━━━━━━━━━━━━━━━━━━

Exchange rate: ₦1,509/$1 (after fees)
Market rate: ₦1,600/$1
```

## Error Handling

The API includes robust error handling:

1. **Parameter Validation**: Ensures amount is provided and valid
2. **Rate Fetching**: Falls back to default rate if API unavailable
3. **Network Issues**: Returns 500 with user-friendly message
4. **Logging**: All errors logged to console for debugging

## Future Enhancements

1. **Tiered Fees**: Implement volume-based fee discounts
2. **Multiple Providers**: Support for different on/off-ramp providers
3. **Route Optimization**: Suggest cheapest payment route
4. **Historical Rates**: Show fee history over time
5. **Fee Alerts**: Notify when fees drop below threshold
6. **Currency Options**: Support more currencies beyond NGN

## Maintenance

### Updating Fee Percentages

To update fee rates, modify the `FEE_CONFIG` object in [route.ts](../app/api/routes-d/utils/fee-quote/route.ts):

```typescript
const FEE_CONFIG = {
  onRamp: {
    percentageFee: 0.035, // Update this
    fixedFee: 0.50,       // and/or this
  },
  offRamp: {
    percentageFee: 0.015, // Update this
    fixedFee: 0.25,       // and/or this
  },
};
```

### Updating Cache Duration

To modify cache duration (currently 60 seconds):

```typescript
const CACHE_DURATION = 60 * 1000; // Change this value (milliseconds)
```

## Support

For questions or issues with the fee quote API:
- Check the project's main README
- Review the test file for usage examples
- Contact the development team via project channels
