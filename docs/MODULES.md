# FreelancerPay402 - Module Architecture

## Folder Structure

```
LancePay/
├── app/                          # Next.js App Router
│   ├── (auth)/                   # Auth route group (no layout)
│   │   ├── login/page.tsx
│   │   └── signup/page.tsx
│   ├── (dashboard)/              # Dashboard route group (with sidebar)
│   │   ├── layout.tsx
│   │   ├── page.tsx              # /dashboard
│   │   ├── invoices/
│   │   │   ├── page.tsx          # /dashboard/invoices
│   │   │   ├── new/page.tsx      # /dashboard/invoices/new
│   │   │   └── [id]/page.tsx     # /dashboard/invoices/:id
│   │   ├── withdrawals/
│   │   │   └── page.tsx          # /dashboard/withdrawals
│   │   └── settings/
│   │       └── page.tsx          # /dashboard/settings
│   ├── pay/
│   │   └── [invoiceId]/page.tsx  # Public payment page
│   ├── api/                      # API Routes
│   │   ├── auth/
│   │   ├── user/
│   │   ├── invoices/
│   │   ├── bank-accounts/
│   │   ├── withdrawals/
│   │   ├── pay/
│   │   └── webhooks/
│   ├── layout.tsx                # Root layout
│   ├── page.tsx                  # Landing page
│   └── globals.css
│
├── modules/                      # Feature modules
│   ├── auth/
│   │   ├── components/
│   │   ├── hooks/
│   │   └── types.ts
│   ├── dashboard/
│   │   ├── components/
│   │   ├── hooks/
│   │   └── types.ts
│   ├── invoices/
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── actions.ts
│   │   └── types.ts
│   ├── payments/
│   │   ├── components/
│   │   ├── hooks/
│   │   └── types.ts
│   ├── withdrawals/
│   │   ├── components/
│   │   ├── hooks/
│   │   └── types.ts
│   └── settings/
│       ├── components/
│       ├── hooks/
│       └── types.ts
│
├── components/                   # Shared UI components
│   ├── ui/                       # Base components (Button, Input, etc.)
│   ├── layout/                   # Layout components (Sidebar, Navbar)
│   └── common/                   # Common components (Logo, LoadingSpinner)
│
├── lib/                          # Shared utilities
│   ├── db.ts                     # Prisma client
│   ├── auth.ts                   # Privy server helpers
│   ├── redis.ts                  # Upstash Redis
│   ├── blockchain.ts             # Viem/Alchemy helpers
│   ├── utils.ts                  # General utilities
│   └── validations.ts            # Zod schemas
│
├── hooks/                        # Shared hooks
│   └── use-toast.ts
│
├── types/                        # Global types
│   └── index.ts
│
├── prisma/
│   └── schema.prisma             # Database schema
│
└── docs/
    ├── DEVOPS.md
    └── MODULES.md
```

## Module Responsibilities

### 1. Auth Module (`modules/auth/`)
- **Purpose**: Handle authentication with Privy (Google OAuth)
- **Components**: LoginButton, AuthGuard, UserMenu
- **Hooks**: useAuth, useUser, useWallet
- **No conflicts**: Only module that interacts with Privy SDK
- **Single Auth Architecture**: All client and API authentication runs exclusively through Privy (via `verifyAuthToken` in `lib/auth.ts`). `next-auth` is completely removed from dependencies and routes.

### 2. Dashboard Module (`modules/dashboard/`)
- **Purpose**: Main dashboard UI after login
- **Components**: BalanceCard, RecentTransactions, QuickActions, StatsGrid
- **Hooks**: useBalance, useRecentActivity
- **Depends on**: Auth (for user data)

### 3. Invoices Module (`modules/invoices/`)
- **Purpose**: Invoice CRUD and management
- **Components**: InvoiceList, InvoiceForm, InvoiceCard, PaymentLinkShare
- **Hooks**: useInvoices, useCreateInvoice, useInvoice
- **Actions**: createInvoice, updateInvoice, deleteInvoice
- **Depends on**: Auth (for user context)

### 4. Payments Module (`modules/payments/`)
- **Purpose**: Public payment page for clients
- **Components**: PaymentPage, OnrampWidget, PaymentSuccess
- **Hooks**: usePaymentStatus
- **No auth required**: Public-facing

### 5. Withdrawals Module (`modules/withdrawals/`)
- **Purpose**: Bank withdrawals and history
- **Components**: WithdrawalModal, BankSelector, ExchangeRateDisplay, WithdrawalHistory
- **Hooks**: useWithdrawals, useExchangeRate, useBankAccounts
- **Depends on**: Auth, Settings (for bank accounts)

### 6. Settings Module (`modules/settings/`)
- **Purpose**: User profile and bank account management
- **Components**: ProfileForm, BankAccountList, AddBankAccountModal
- **Hooks**: useProfile, useBankAccountMutations
- **Depends on**: Auth

## API Routes by Module

| Module | API Routes | Auth Required |
|--------|------------|---------------|
| Auth | `/api/auth/*`, `/api/webhooks/privy` | No (webhooks) |
| Dashboard | `/api/user/balance`, `/api/user/profile` | Yes |
| Invoices | `/api/invoices/*` | Yes |
| Payments | `/api/pay/[id]` | No (public) |
| Withdrawals | `/api/withdrawals/*`, `/api/exchange-rate` | Yes |
| Settings | `/api/bank-accounts/*` | Yes |

## Conflict Prevention Rules

1. **Module isolation**: Each module has its own `types.ts` - no shared types between modules
2. **API ownership**: Each API route belongs to one module only
3. **Component naming**: Prefix with module name if exported (e.g., `InvoiceCard`, not `Card`)
4. **Hook naming**: Include module context (e.g., `useInvoices`, not `useList`)
5. **Shared code**: Goes in `lib/` or `components/ui/` - never in modules
