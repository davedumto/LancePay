# LancePay Code Style Guide

> Write human code. Less is more.

---

## Core Principles

1. **Less code = less bugs**
2. **If it works, ship it**
3. **Refactor later, not now**
4. **Comments are for "why", not "what"**

---

## ❌ Don't Do This

```tsx
// DON'T: Over-abstracted, over-commented garbage

/**
 * @description Fetches the user balance from the API
 * @param {string} userId - The unique identifier of the user
 * @returns {Promise<Balance>} The user's balance object
 * @throws {Error} If the API request fails
 */
async function fetchUserBalance(userId: string): Promise<Balance> {
  // Construct the API endpoint URL
  const endpoint = buildEndpoint('/api/user/balance', { userId });
  
  // Make the request with proper error handling
  const response = await makeAuthenticatedRequest(endpoint, {
    method: 'GET',
    headers: getDefaultHeaders(),
  });
  
  // Validate the response
  if (!response.ok) {
    throw new UserBalanceError('Failed to fetch balance', response.status);
  }
  
  // Parse and return the data
  return parseBalanceResponse(await response.json());
}
```

---

## ✅ Do This Instead

```tsx
// DO: Straight to the point

async function getBalance(token: string) {
  const res = await fetch('/api/user/balance', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok ? res.json() : null;
}
```

---

## Rules

### 1. No JSDoc for obvious things
```tsx
// ❌ No
/** Gets the user */
function getUser() {}

// ✅ Yes - only comment non-obvious things
// Yellow Card requires amount in kobo (NGN cents)
const koboAmount = ngnAmount * 100;
```

### 2. No wrapper functions for single operations
```tsx
// ❌ No
function navigateToDashboard() {
  router.push('/dashboard');
}

// ✅ Yes
router.push('/dashboard');
```

### 3. No unnecessary abstractions
```tsx
// ❌ No
const config = {
  endpoints: {
    invoices: '/api/invoices',
    balance: '/api/user/balance',
  }
};
fetch(config.endpoints.invoices);

// ✅ Yes
fetch('/api/invoices');
```

### 4. Inline simple logic
```tsx
// ❌ No
function isValidAmount(amount: number): boolean {
  return amount > 0 && amount <= 100000;
}
if (isValidAmount(amount)) { ... }

// ✅ Yes
if (amount > 0 && amount <= 100000) { ... }
```

### 5. Use early returns
```tsx
// ❌ No
function processPayment(invoice) {
  if (invoice) {
    if (invoice.status === 'pending') {
      if (invoice.amount > 0) {
        // actual logic 3 levels deep
      }
    }
  }
}

// ✅ Yes
function processPayment(invoice) {
  if (!invoice) return;
  if (invoice.status !== 'pending') return;
  if (invoice.amount <= 0) return;
  
  // actual logic at top level
}
```

### 6. One file, one purpose
```
// ❌ No
utils/
  helpers.ts  (500 lines of random stuff)

// ✅ Yes
lib/
  format.ts   (formatCurrency, formatDate)
  db.ts       (prisma client)
```

### 7. No types for everything
```tsx
// ❌ No - obvious from usage
interface ButtonClickHandlerProps {
  onClick: () => void;
}

// ✅ Yes - only type what matters
interface Invoice {
  id: string;
  amount: number;
  status: 'pending' | 'paid' | 'cancelled';
}
```

### 8. Components: 50 lines max
If a component is > 50 lines, split it.

```tsx
// ❌ No - 200 line component with everything

// ✅ Yes
// InvoiceCard.tsx - 30 lines
// InvoiceList.tsx - 20 lines
// InvoiceForm.tsx - 45 lines
```

### 9. API routes: Simple in, simple out
```tsx
// ❌ No
export async function POST(req) {
  const body = await req.json();
  const validated = invoiceSchema.parse(body);
  const sanitized = sanitizeInput(validated);
  const enriched = enrichWithDefaults(sanitized);
  const invoice = await createInvoice(enriched);
  const response = formatResponse(invoice);
  return NextResponse.json(response);
}

// ✅ Yes
export async function POST(req) {
  const { clientEmail, description, amount } = await req.json();
  
  const invoice = await prisma.invoice.create({
    data: { clientEmail, description, amount, userId: user.id }
  });
  
  return NextResponse.json(invoice);
}
```

### 10. State: Use what you need
```tsx
// ❌ No - state management library for 3 values
const store = createStore({
  balance: 0,
  loading: true,
  error: null,
});

// ✅ Yes
const [balance, setBalance] = useState(0);
const [loading, setLoading] = useState(true);
```

---

## Naming

| Type | Convention | Example |
|------|------------|---------|
| Files | kebab-case | `invoice-card.tsx` |
| Components | PascalCase | `InvoiceCard` |
| Functions | camelCase | `getBalance` |
| Constants | SCREAMING_SNAKE | `MAX_AMOUNT` |
| Booleans | is/has/can prefix | `isLoading`, `hasError` |

---

## File Size Limits

| Type | Max Lines |
|------|-----------|
| Component | 50 |
| API Route | 40 |
| Hook | 30 |
| Utility | 20 |

If you hit the limit, split the file.

---

## Currency & Number Formatting

Use `formatCurrency` / `formatNaira` from `lib/utils.ts` — never hand-roll
`Intl.NumberFormat` calls or `toFixed` for money display.

- `formatCurrency(amount, currency, locale)` derives fraction digits from
  `Intl` for the currency (USD/NGN → 2, JPY → 0). Pass the user's locale;
  the default is `en-US`/`USD`.
- `formatNaira(amount)` rounds to whole naira for display. Pass
  `{ exact: true }` wherever the amount feeds fee math or is shown in a
  withdrawal/payment confirmation — kobo must not be hidden there.
- Locale and currency are display-only concerns; never format a value and
  then parse it back for calculations.

---

## Remember

> "The best code is no code at all."
> — Every senior dev who's had to maintain someone else's overengineered mess

Ship it. Make it work. Refactor when you need to, not before.
