# LancePay - Module & Codebase Architecture

## 1. Directory Layout

The LancePay repository is organized as a unified Next.js (App Router) full-stack application. It does not use an isolated `modules/` directory; instead, application code is partitioned into domain-driven layers across `app/`, `components/`, `hooks/`, and `lib/`.

```
LancePay/
├── app/                          # Next.js App Router (Pages, Layouts & API)
│   ├── (auth)/                   # Authentication route group (login, signup)
│   ├── (dashboard)/              # Authenticated user dashboard route group
│   ├── pay/                      # Public invoice checkout & payment page
│   ├── api-docs/                 # Swagger UI and OpenAPI documentation
│   └── api/                      # Backend REST, webhook & GraphQL routes
│       ├── routes-b/             # Secondary domain & extended feature routes
│       ├── routes-d/             # Operational, admin & security routes
│       ├── auth/                 # Core user authentication & session management
│       ├── invoices/             # Core invoice creation, updating, and querying
│       ├── withdrawals/          # Core off-ramp and withdrawal requests
│       ├── webhooks/             # External webhook ingesters (MoonPay, Yellow Card, Privy)
│       ├── graphql/              # GraphQL schema gateway and execution
│       └── cron/                 # Vercel cron jobs (overdue invoice handling)
│
├── components/                   # React UI components
│   ├── ui/                       # Base design system primitives (Button, Input, Badge, etc.)
│   ├── layout/                   # Structural components (Navbar, Sidebar, Footer)
│   ├── dashboard/                # Dashboard widgets, stats grids, and overview cards
│   ├── invoices/                 # Invoice builder, viewer, and state badges
│   └── payments/                 # Payment modal, QR codes, and currency selectors
│
├── hooks/                        # Custom React hooks
│   ├── usePayments.ts            # Client-side payment execution & status polling
│   ├── useTransactionHistory.ts   # On-chain and database transaction pagination
│   ├── useCountUp.ts             # Animated number ticker for financial balances
│   └── useInactivityTimeout.ts   # Session inactivity auto-logout protection
│
├── lib/                          # Core business logic and service integrations
│   ├── db.ts                     # Prisma client singleton (PostgreSQL / Neon)
│   ├── logger.ts                 # Structured Pino logger
│   ├── email.ts                  # Transactional email dispatcher (Resend)
│   ├── pdf.tsx                   # Server-side PDF invoice generation (@react-pdf)
│   └── [Domain modules...]       # Stellar, payments, compliance, auth, etc.
│
├── contracts/                    # Soroban smart contracts (Rust SDK)
├── docs/                         # Technical documentation & architecture guides
└── prisma/                       # Prisma database schema & migration files
```

---

## 2. API Route Architecture

Backend endpoints in `app/api` are categorized into three distinct tiers:

### 2.1 Top-Level API Routes (`app/api/*`)
Directly service primary user workflows and public entry points:
- `/api/auth/*`: User login, session verification, and Privy OAuth synchronization.
- `/api/invoices/*`: Core invoice CRUD, client view tracking, and status transitions.
- `/api/pay/*`: Public payment resolution and hosted checkout sessions.
- `/api/withdrawals/*`: Bank withdrawal requests and status callbacks.
- `/api/webhooks/*`: MoonPay, Yellow Card, and Privy signature verification and event handling.
- `/api/graphql/*`: Public and filtered GraphQL gateway schemas.
- `/api/cron/*`: Scheduled background maintenance (e.g. overdue invoice cancellation).

### 2.2 Secondary Domain Routes (`app/api/routes-b/*`)
Handles extended business logic and sub-domain features associated with invoices and collaboration:
- **Invoice Line Extensions**: Partial payments, tax lines, currency conversions, and PDF regeneration.
- **Reporting & Summaries**: Monthly and yearly invoice performance rollups.
- **Collaboration & Workspace**: Pinned notes, team announcements, search history, and language preferences.
- **Subscriptions & Billing**: Recurring payment schedules and client subscription tracking.

### 2.3 Operational & Administrative Routes (`app/api/routes-d/*`)
Reserved for administrative, platform health, security controls, and enterprise integrations:
- **Security & Access**: IP allowlisting, trusted devices, session revocations, and password recovery.
- **Compliance & Watchlists**: Sanctions screening, address cooldown statuses, and chargeback audits.
- **System Health & Maintenance**: Prometheus metrics, cache statistics, database backup triggers, and job queue management.
- **Enterprise Integrations**: SCIM v2 directory synchronization, SAML/SSO configuration, and Plaid/Circle test harness sinks.

---

## 3. Core `lib/` Modules by Domain

The `lib/` folder contains domain services and utility modules. Upstash Redis and Viem/Alchemy are not used as standalone infrastructure files; caching and ledger logic reside in dedicated domain files.

### 3.1 Stellar & Blockchain Infrastructure
- `lib/stellar.ts`: Stellar SDK initialization, Horizon client, transaction submission, and account loading.
- `lib/stellar-funding.ts`: Automated account creation, XLM reserve funding, and trustline establishment.
- `lib/claimable-balances.ts`: Shared constants and error mappers (including `op_no_trust` handling) for claimable balance workflows.
- `lib/sep24.ts`: Stellar Ecosystem Proposal 24 interactive deposit and withdrawal protocol handler.
- `lib/anchors.ts` & `lib/assets.ts`: Stellar anchor metadata and supported asset configurations (XLM, USDC, EURC).
- `lib/fee-estimation.ts` & `lib/fee-rates.ts`: Real-time network base fee calculations and surge pricing adjustments.

### 3.2 Payments, FX & Off-Ramping
- `lib/offramp.ts`: Yellow Card API client for USDC-to-NGN off-ramp and Nigerian bank transfers.
- `lib/withdrawal-ledger.ts`: Double-entry accounting ledger tracking withdrawals and fee reserves.
- `lib/money.ts`: High-precision financial arithmetic, currency formatting, and subunit conversions.
- `lib/pricing.ts` & `lib/fee-rates.ts`: Freelancer fee calculations, platform margins (<1%), and caps.
- `lib/fx-rates.ts` & `lib/exchange-rate.ts`: USD/NGN foreign exchange feeds and provider quote comparison.
- `lib/invoice-fx-lock.ts`: Guaranteed exchange rate locking during open checkout windows.
- `lib/quote-conversion.ts`: Quote generation and fee decomposition for international clients.
- `lib/manual-payment-reconciliation.ts`: Reconciliation engine for bank transfers and manual receipts.

### 3.3 Authentication, Authorization & Security
- **Single Auth Architecture**: All client and API authentication runs exclusively through Privy (via `verifyAuthToken` in `lib/auth.ts`). `next-auth` is completely removed from dependencies and routes.
- `lib/auth.ts`: Privy server authentication token verification and user extraction.
- `lib/authorization.ts`: Role-based access control (RBAC) and invoice ownership guards.
- `lib/two-factor.ts`: TOTP two-factor authentication setup and speakeasy token validation.
- `lib/crypto.ts`: Key derivation, symmetric payload encryption, and cryptographic helpers.
- `lib/rate-limit.ts`: Token bucket and sliding window rate limiting.
- `lib/client-ip.ts`: Trusted proxy headers parser and client IP extraction.
- `lib/csp-nonce.ts`: Content Security Policy nonce generator for script tag isolation.
- `lib/privy-webhook-verify.ts` & `lib/webhook-signature.ts`: Cryptographic HMAC and public-key webhook verification.

### 3.4 Compliance, Risk & Trust
- `lib/kyc-config.ts`: Identity verification tiers, document requirements, and verification thresholds.
- `lib/bank-verification.ts`: Nigerian NUBAN account validation and account name matching.
- `lib/trust-score.ts`: Dynamic user trust score computation based on payment history and dispute frequency.
- `lib/client-reputation.ts`: Client credit risk and chargeback probability scoring.
- `lib/audit.ts`: Immutable security audit log persistence.
- `lib/badges.ts`: Freelancer reputation and verification badge state machine.
- `lib/account-deletion.ts`: GDPR/NDPR compliance routines for complete account data erasure.

### 3.5 Core System & Utilities
- `lib/db.ts`: Prisma ORM client instance with connection pooling.
- `lib/logger.ts`: Centralized Pino logger instance with environment-aware formatting.
- `lib/email.ts`: Transactional email templates and delivery via Resend.
- `lib/pdf.tsx`: React-PDF invoice document layout and streaming PDF buffer generation.
- `lib/validations.ts`: Zod validation schemas for all inbound API payloads.
- `lib/shared-cache.ts`: Shared in-memory and distributed cache interface.
- `lib/persisted-queries.ts`: Pre-registered GraphQL query hash registry.
- `lib/utils.ts`: Tailwind class merging (`cn`) and general string/date utilities.
