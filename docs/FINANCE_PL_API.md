# Finance P&L Module Documentation

## Overview
The Finance P&L (Profit & Loss) module provides professional-grade financial reporting for freelancers and agencies using LancePay. This feature generates structured financial statements suitable for loan applications, tax preparation, and business performance analysis.

## API Endpoint

### GET `/api/routes-d/finance/p-and-l`

Generates a Profit & Loss statement for a specified time period.

#### Authentication
Requires Bearer token in Authorization header:
```
Authorization: Bearer <privy_auth_token>
```

#### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `period` | string | Yes | Time period for the report. Options: `current_month`, `last_month`, `current_quarter`, `last_year` |
| `format` | string | No | Response format. Options: `json` (default), `pdf` |

#### Example Requests

**JSON Format (Default)**
```bash
GET /api/routes-d/finance/p-and-l?period=current_month
Authorization: Bearer <token>
```

**PDF Format**
```bash
GET /api/routes-d/finance/p-and-l?period=last_year&format=pdf
Authorization: Bearer <token>
```

#### Response Format (JSON)

```json
{
  "period": "January 2026",
  "dateRange": {
    "start": "2026-01-01",
    "end": "2026-01-31"
  },
  "summary": {
    "totalIncome": 2500.00,
    "platformFees": 12.50,
    "withdrawalFees": 5.00,
    "operatingExpenses": 1000.00,
    "netProfit": 1482.50
  },
  "topClients": [
    {
      "name": "Acme Corp",
      "email": "acme@example.com",
      "revenue": 1500.00,
      "invoiceCount": 3
    }
  ],
  "currency": "USD"
}
```

#### Response Format (PDF)

Returns a PDF document with `Content-Type: application/pdf` header. The PDF includes:
- LancePay branded header
- Freelancer information
- Period and date range
- Income statement with detailed breakdown
- Top 5 clients by revenue
- Professional footer with generation timestamp

## Financial Calculations

### Revenue Recognition
- **Income Sources**: Completed transactions of type `incoming` (invoice payments) and `payment` (MoonPay top-ups)
- **Time Period**: Based on `completedAt` timestamp in UTC
- **Refunds**: Subtracted from gross income

### Fee Structure
Following the tax-reports module for consistency:

| Fee Type | Rate | Applied To |
|----------|------|------------|
| Platform Fee | 0.5% | Each income transaction |
| Withdrawal Fee | 0.5% | Each withdrawal transaction |

**Calculation Examples:**
- $1,000 income → $5.00 platform fee
- $500 withdrawal → $2.50 withdrawal fee

### Net Profit Formula
```
Net Profit = Gross Income - Platform Fees - Withdrawal Fees - Operating Expenses

Where:
- Gross Income = Total Income - Refunds
- Platform Fees = Sum of (Income Amount × 0.5%)
- Withdrawal Fees = Sum of (Withdrawal Amount × 0.5%)
- Operating Expenses = Total Withdrawal Amounts
```

## Period Definitions

### current_month
- Start: First day of current month at 00:00 UTC
- End: First day of next month at 00:00 UTC (exclusive)
- Example: January 1, 2026 00:00 to February 1, 2026 00:00

### last_month
- Start: First day of previous month at 00:00 UTC
- End: First day of current month at 00:00 UTC (exclusive)
- Example: December 1, 2025 00:00 to January 1, 2026 00:00

### current_quarter
- Quarters: Q1 (Jan-Mar), Q2 (Apr-Jun), Q3 (Jul-Sep), Q4 (Oct-Dec)
- Start: First day of quarter at 00:00 UTC
- End: First day of next quarter at 00:00 UTC (exclusive)
- Example: Q1 2026 = January 1, 2026 00:00 to April 1, 2026 00:00

### last_year
- Start: January 1 of previous year at 00:00 UTC
- End: January 1 of current year at 00:00 UTC (exclusive)
- Example: January 1, 2025 00:00 to January 1, 2026 00:00

## Top Clients Analysis

The report includes top 5 clients by revenue:
- Grouped by client email address (case-insensitive)
- Sorted by total revenue (descending)
- Includes invoice count per client
- Only includes transactions with associated invoices

## Error Responses

### 400 Bad Request
```json
{
  "error": "period parameter is required (current_month, last_month, current_quarter, last_year)"
}
```

### 401 Unauthorized
```json
{
  "error": "Unauthorized"
}
```

### 500 Internal Server Error
```json
{
  "error": "Failed to generate P&L report"
}
```

## Implementation Files

### Core Files
1. **`app/api/routes-d/finance/_shared.ts`**
   - Authentication utilities
   - Fee calculation functions
   - Period date range utilities
   - Rounding helpers

2. **`app/api/routes-d/finance/p-and-l/route.ts`**
   - Main GET endpoint handler
   - Transaction aggregation logic
   - Client analysis
   - Format routing (JSON/PDF)

3. **`lib/finance-pdf.tsx`**
   - React PDF template component
   - Professional bank-ready styling
   - Income statement layout
   - Top clients table

### Test File
- **`test-p-and-l.js`** - Business logic validation tests

## Usage Examples

### Frontend Integration

```typescript
// Fetch JSON report
async function fetchPLReport(period: string) {
  const response = await fetch(
    `/api/routes-d/finance/p-and-l?period=${period}`,
    {
      headers: {
        Authorization: `Bearer ${authToken}`
      }
    }
  );
  return await response.json();
}

// Download PDF report
async function downloadPLReport(period: string) {
  const response = await fetch(
    `/api/routes-d/finance/p-and-l?period=${period}&format=pdf`,
    {
      headers: {
        Authorization: `Bearer ${authToken}`
      }
    }
  );
  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `P&L-${period}-${Date.now()}.pdf`;
  a.click();
}
```

### CLI Testing

```bash
# Get current month P&L as JSON
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "http://localhost:3000/api/routes-d/finance/p-and-l?period=current_month"

# Download last year P&L as PDF
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "http://localhost:3000/api/routes-d/finance/p-and-l?period=last_year&format=pdf" \
  --output P&L-last-year.pdf
```

## Performance Considerations

### Query Optimization
- Uses indexed fields (`userId`, `status`, `type`, `completedAt`)
- Filters at database level to minimize data transfer
- Aggregation performed in application layer (simpler than SQL groupBy for this use case)

### Expected Performance
- Users with < 1,000 transactions: < 100ms
- Users with 1,000-10,000 transactions: 100-500ms
- Users with > 10,000 transactions: < 1 second

### No Caching
Financial data requires real-time accuracy, so no caching is implemented. Each request fetches fresh data from the database.

## Security

### Authentication
- Uses Privy authentication tokens
- User isolation enforced at database query level
- Auto-creates user record if not exists

### Data Access
- Users can only access their own financial data
- No admin override functionality
- All queries filtered by authenticated user ID

## Future Enhancements

### Potential Features
1. **Custom Date Ranges**: Allow arbitrary start/end dates
2. **Multi-Currency Support**: Handle transactions in multiple currencies
3. **Expense Categories**: Break down operating expenses by type
4. **Year-over-Year Comparisons**: Show growth trends
5. **CSV Export**: Additional export format option
6. **Email Delivery**: Scheduled report delivery
7. **Saved Reports**: Store generated reports for future reference
8. **Budget vs Actual**: Compare against budget targets

### Database Optimization Ideas
1. **Materialized Views**: Pre-aggregate monthly/quarterly data
2. **Fee Storage**: Store calculated fees in transaction records
3. **Report Cache Table**: Store generated reports for quick retrieval

## Testing Checklist

- [x] Empty period (no transactions)
- [x] Single month with typical activity
- [x] High volume month (50+ transactions)
- [x] Fee accuracy (exactly 0.5% of amounts)
- [x] Negative profit scenario
- [x] Top clients sorting
- [ ] PDF generation and formatting
- [ ] All period types (month/quarter/year)
- [ ] Quarter boundary conditions
- [ ] Timezone handling (UTC)
- [ ] Large dataset performance (10,000+ transactions)

## Support

For issues or questions about the P&L reporting feature, refer to:
- API Documentation: `/docs/FEE_QUOTE_API.md`
- Tax Reports Implementation: `app/api/routes-d/tax-reports/`
- Main Project README: `README.md`
