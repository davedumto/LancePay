# FreelancerPay402 - DevOps & Infrastructure Guide

> Architecture, Security, Scalability, and Deployment Documentation

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Environment Strategy](#2-environment-strategy)
3. [Infrastructure Setup](#3-infrastructure-setup)
4. [Security Best Practices](#4-security-best-practices)
5. [Deployment Pipeline](#5-deployment-pipeline)
6. [Scalability Strategy](#6-scalability-strategy)
7. [Monitoring & Observability](#7-monitoring--observability)
8. [Disaster Recovery](#8-disaster-recovery)
9. [Cost Optimization](#9-cost-optimization)

---

## 1. Architecture Overview

### High-Level Architecture

```
                                    ┌─────────────────────────────────────┐
                                    │           CLOUDFLARE               │
                                    │   (DDoS Protection, WAF, CDN)      │
                                    └─────────────────┬───────────────────┘
                                                      │
                    ┌─────────────────────────────────┼─────────────────────────────────┐
                    │                                 │                                 │
                    ▼                                 ▼                                 ▼
          ┌─────────────────┐               ┌─────────────────┐               ┌─────────────────┐
          │    VERCEL       │               │    VERCEL       │               │    VERCEL       │
          │  (Frontend)     │               │  (API Routes)   │               │  (Webhooks)     │
          │  lancepay.com   │               │  /api/*         │               │  /api/webhooks  │
          └────────┬────────┘               └────────┬────────┘               └────────┬────────┘
                   │                                 │                                 │
                   │                                 │                                 │
                   └─────────────────────────────────┼─────────────────────────────────┘
                                                     │
                    ┌────────────────────────────────┼────────────────────────────────┐
                    │                                │                                │
                    ▼                                ▼                                ▼
          ┌─────────────────┐               ┌─────────────────┐               ┌─────────────────┐
          │      NEON       │               │  IN-MEMORY      │               │    STELLAR      │
          │  (PostgreSQL)   │               │  RATE LIMITING  │               │   HORIZON       │
          │   Serverless    │               │ (per-instance)  │               │ (RPC + account  │
          └─────────────────┘               └─────────────────┘               │    data)        │
                                                                            └─────────────────┘
                    
                    ┌────────────────────────────────────────────────────────────────┐
                    │                     EXTERNAL SERVICES                          │
                    ├─────────────────┬────────────────┬────────────────┬────────────┤
                    │      PRIVY      │    MOONPAY     │  YELLOW CARD   │   RESEND   │
                    │ (Google Auth +  │   (Onramp)     │   (Offramp)    │  (Email)   │
                    │ Embedded Wallet)│                │                │            │
                    └─────────────────┴────────────────┴────────────────┴────────────┘
```

### Recommended Stack

| Layer | Technology | Why |
|-------|------------|-----|
| **Frontend + API** | Vercel (Next.js) | Edge functions, auto-scaling, zero config |
| **Database** | Neon (PostgreSQL) | True serverless, branching, global edge |
| **Auth + Wallets** | Privy | Google OAuth + embedded wallets in one SDK |
| **Rate Limiting** | In-memory store (`lib/rate-limit.ts`, `lib/shared-cache.ts`) | Zero external deps; per-instance on serverless |
| **Blockchain RPC** | Stellar Horizon (`NEXT_PUBLIC_STELLAR_HORIZON_URL`) | Native ledger for USDC payments and account data |
| **CDN/Security** | Cloudflare | DDoS protection, WAF, caching |
| **Secrets** | Vercel Environment Variables | Encrypted, per-environment |
| **Monitoring** | Sentry + Vercel Analytics | Errors + performance |
| **Email** | Resend | Developer-friendly, reliable |

### Why Neon over Supabase?

| Aspect | Neon | Supabase |
|--------|------|----------|
| **Serverless** | ✅ True serverless, scales to zero | ⚠️ Pauses on free tier |
| **DB Branching** | ✅ Branch per PR (great for testing) | ❌ Not available |
| **Cold Starts** | ✅ Faster cold starts | ⚠️ Slower wake-up |
| **Built-in Auth** | ❌ (we use Privy anyway) | ✅ (not needed) |
| **Focus** | Pure database, no bloat | Full platform |

### Why Privy for Auth + Wallets?

Privy handles **both authentication AND embedded wallet creation** in one integration:

```
User clicks "Sign in with Google"
         │
         ▼
   Privy handles Google OAuth
         │
         ▼
   Embedded wallet auto-created
   (tied to Google account)
         │
         ▼
   User logged in + has wallet
   (never sees crypto complexity)
```

**No need for separate auth provider.** One SDK does both.

---

## 2. Environment Strategy

### Three Environments

| Environment | Purpose | Database | External APIs |
|-------------|---------|----------|---------------|
| **Development** | Local dev, feature branches | Neon dev branch | Sandbox/Mock |
| **Staging** | Pre-production testing | Neon staging branch | Sandbox APIs |
| **Production** | Live users | Neon main branch | Production APIs |

### Branch Strategy

```
main (production)
  │
  ├── staging (auto-deploys to staging.lancepay.com)
  │     │
  │     └── feature/xyz (PR preview deployments + Neon DB branch)
  │
  └── hotfix/abc (emergency fixes → main)
```

### Environment Variables Structure

```bash
# .env.local (development)
# .env.staging (staging - in Vercel)
# .env.production (production - in Vercel)

# ═══════════════════════════════════════════════════════════════
# APPLICATION
# ═══════════════════════════════════════════════════════════════
NEXT_PUBLIC_APP_URL=https://lancepay.com
NEXT_PUBLIC_APP_ENV=production  # development | staging | production

# ═══════════════════════════════════════════════════════════════
# DATABASE (Neon)
# ═══════════════════════════════════════════════════════════════
DATABASE_URL="postgresql://user:pass@ep-xxx.us-east-1.aws.neon.tech/lancepay?sslmode=require"

# ═══════════════════════════════════════════════════════════════
# PRIVY (Google Auth + Embedded Wallets)
# ═══════════════════════════════════════════════════════════════
NEXT_PUBLIC_PRIVY_APP_ID=your-privy-app-id
PRIVY_APP_SECRET=your-privy-app-secret
PRIVY_WEBHOOK_SECRET=your-webhook-secret

# ═══════════════════════════════════════════════════════════════
# BLOCKCHAIN (Stellar)
# ═══════════════════════════════════════════════════════════════
STELLAR_NETWORK=testnet            # testnet | public
STELLAR_FUNDING_WALLET_SECRET=S...
NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
NEXT_PUBLIC_USDC_ISSUER=GA...
NEXT_PUBLIC_USDC_CODE=USDC

# ═══════════════════════════════════════════════════════════════
# ONRAMP (MoonPay)
# ═══════════════════════════════════════════════════════════════
MOONPAY_API_KEY=pk_live_xxx
MOONPAY_SECRET_KEY=sk_live_xxx
MOONPAY_WEBHOOK_SECRET=whsec_xxx

# ═══════════════════════════════════════════════════════════════
# OFFRAMP (Yellow Card)
# ═══════════════════════════════════════════════════════════════
YELLOWCARD_API_KEY=your-api-key
YELLOWCARD_SECRET_KEY=your-secret-key
YELLOWCARD_WEBHOOK_SECRET=your-webhook-secret

# ═══════════════════════════════════════════════════════════════
# EMAIL (Resend)
# ═══════════════════════════════════════════════════════════════
RESEND_API_KEY=re_xxx

# ═══════════════════════════════════════════════════════════════
# MONITORING
# ═══════════════════════════════════════════════════════════════
SENTRY_DSN=https://xxx@sentry.io/xxx
SENTRY_AUTH_TOKEN=xxx
```

---

## 3. Infrastructure Setup

### Vercel Project Configuration

```json
// vercel.json
{
  "framework": "nextjs",
  "regions": ["iad1", "lhr1"],
  "headers": [
    {
      "source": "/api/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "X-XSS-Protection", "value": "1; mode=block" }
      ]
    }
  ],
  "rewrites": [
    {
      "source": "/pay/:invoiceId",
      "destination": "/pay/[invoiceId]"
    }
  ]
}
```

### Neon Setup

```bash
# 1. Create project at neon.tech
# 2. Copy connection string

# 3. Initialize Prisma
npx prisma init

# 4. Run migrations
npx prisma migrate dev --name init
```

```typescript
// lib/db.ts
import { PrismaClient } from '@prisma/client'

const globalForPrisma = global as unknown as { prisma: PrismaClient }

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query'] : [],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
```

### Privy Setup (Google Auth + Embedded Wallets)

```tsx
// app/providers.tsx
'use client';

import { PrivyProvider } from '@privy-io/react-auth';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID!}
      config={{
        // Auth methods
        loginMethods: ['google', 'email'],
        
        // Appearance
        appearance: {
          theme: 'light',
          accentColor: '#111827',
          logo: '/logo.png',
        },
        
        // Embedded wallets - auto-create on login
        embeddedWallets: {
          createOnLogin: 'all-users',
          noPromptOnSignature: true,
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
```

```tsx
// components/AuthButton.tsx
'use client';

import { usePrivy } from '@privy-io/react-auth';

export function AuthButton() {
  const { login, logout, authenticated, user } = usePrivy();

  if (authenticated) {
    // User is logged in AND has embedded wallet
    const walletAddress = user?.wallet?.address;
    
    return (
      <div>
        <span>Welcome, {user?.google?.name || user?.email?.address}</span>
        <button onClick={logout}>Sign Out</button>
      </div>
    );
  }

  return (
    <button onClick={login}>
      Sign in with Google
    </button>
  );
}
```

### Rate Limiting & In-Memory Cache

The app does **not** use a Redis client. Rate limiting and short-lived caching
are handled by in-process stores:

- `lib/rate-limit.ts` — sliding-window counters kept in a global `Map`
  (shared across warm serverless invocations on the same instance). Defines
  middleware policies (`/api/pay`, `/api/auth`) and per-route
  `RouteRateLimiter` instances for 2FA and KYC endpoints.
- `lib/shared-cache.ts` — generic TTL cache (`SharedCache`) used for
  exchange-rate and other frequently read values.

Because the store is per-instance, limits are approximate under horizontal
scaling — sufficient for abuse prevention, not for strict quotas.

---

## 4. Security Best Practices

### Authentication with Privy

Privy handles auth securely. You verify the session server-side:

```typescript
// lib/auth.ts
import { PrivyClient } from '@privy-io/server-auth';

const privy = new PrivyClient(
  process.env.NEXT_PUBLIC_PRIVY_APP_ID!,
  process.env.PRIVY_APP_SECRET!
);

export async function verifyAuth(authToken: string) {
  try {
    const claims = await privy.verifyAuthToken(authToken);
    return { userId: claims.userId, walletAddress: claims.walletAddress };
  } catch {
    return null;
  }
}
```

```typescript
// middleware.ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const PUBLIC_PATHS = ['/api/pay', '/api/webhooks', '/api/health']

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname
  
  // Allow public paths
  if (PUBLIC_PATHS.some(p => path.startsWith(p))) {
    return NextResponse.next()
  }
  
  // Check for Privy auth token
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  // Token verification happens in the route handler
  return NextResponse.next()
}

export const config = {
  matcher: '/api/:path*',
}
```

### Webhook Security

```typescript
// app/api/webhooks/privy/route.ts
import { headers } from 'next/headers'
import crypto from 'crypto'

export async function POST(request: Request) {
  const body = await request.text()
  const signature = headers().get('privy-signature')
  
  // Verify webhook signature
  const expectedSignature = crypto
    .createHmac('sha256', process.env.PRIVY_WEBHOOK_SECRET!)
    .update(body)
    .digest('hex')
  
  if (signature !== expectedSignature) {
    return Response.json({ error: 'Invalid signature' }, { status: 401 })
  }
  
  const event = JSON.parse(body)
  
  // Handle user.created - store wallet address
  if (event.type === 'user.created') {
    const { id, wallet } = event.data
    await prisma.user.create({
      data: {
        privyId: id,
        walletAddress: wallet?.address,
      }
    })
  }
  
  return Response.json({ received: true })
}
```

### API Security Checklist

| Security Measure | Implementation |
|------------------|----------------|
| **Authentication** | Privy (Google OAuth + session tokens) |
| **Rate Limiting** | In-memory limiter in `lib/rate-limit.ts` (policies for `/api/pay`, `/api/auth`, 2FA, KYC) |
| **Input Validation** | Zod schemas on all inputs |
| **SQL Injection** | Parameterized queries (Prisma) |
| **XSS** | React auto-escapes, CSP headers |
| **Secrets** | Vercel encrypted env vars |
| **HTTPS** | Enforced by Vercel |
| **Webhook Auth** | HMAC signature verification |

---

## 5. Deployment Pipeline

### GitHub Actions CI/CD

```yaml
# .github/workflows/ci.yml
name: CI/CD Pipeline

on:
  push:
    branches: [main, staging]
  pull_request:
    branches: [main, staging]

jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run linter
        run: npm run lint
      
      - name: Run type check
        run: npm run type-check
      
      - name: Run tests
        run: npm run test
        env:
          DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}

  deploy-production:
    if: github.ref == 'refs/heads/main'
    needs: [lint-and-test]
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      
      - name: Deploy to Vercel
        uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          vercel-args: '--prod'
```

### Database Migrations with Neon Branching

```yaml
# .github/workflows/preview.yml
name: Preview Deployment

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  create-neon-branch:
    runs-on: ubuntu-latest
    steps:
      - uses: neondatabase/create-branch-action@v4
        with:
          project_id: ${{ secrets.NEON_PROJECT_ID }}
          branch_name: preview-${{ github.event.pull_request.number }}
          api_key: ${{ secrets.NEON_API_KEY }}
        id: branch
      
      - name: Set preview DATABASE_URL
        run: echo "DATABASE_URL=${{ steps.branch.outputs.db_url }}" >> $GITHUB_ENV
```

---

## 6. Scalability Strategy

### Vercel Auto-Scaling

Vercel handles scaling automatically:
- **Edge Functions**: Run in 30+ regions globally
- **Serverless Functions**: Scale to zero, burst to 1000s
- **No cold starts** for Edge Runtime

### Database Scaling (Neon)

| Traffic Level | Neon Tier | Features |
|---------------|-----------|----------|
| **MVP (< 1K users)** | Free | 0.5 GB storage, auto-suspend |
| **Growth (< 10K users)** | Launch ($19/mo) | 10 GB storage, no suspend |
| **Scale (< 100K users)** | Scale ($69/mo) | Autoscaling, read replicas |
| **Enterprise** | Custom | Dedicated resources |

### Caching Strategy

```typescript
// Cache frequently accessed data (per-instance, see lib/shared-cache.ts)
export async function getExchangeRate() {
  const cached = sharedCache.get('exchange_rate:USD_NGN')
  if (cached) return cached
  
  const rate = await fetchFromYellowCard()
  sharedCache.set('exchange_rate:USD_NGN', rate, 5 * 60_000)
  return rate
}
```

---

## 7. Monitoring & Observability

### Log Redaction

The pino logger in `lib/logger.ts` redacts sensitive values before they reach Vercel logs. The redaction list covers:

- `authorization`, `cookie`, and `signature` headers (`signature`, `x-yc-signature`, `moonpay-signature`, `moonpay-signature-v2`, including nested `req.headers.*` paths)
- Secret-like keys: `apiKey`/`api_key`, `accessToken`/`access_token`, `refreshToken`/`refresh_token`, `secret`, `clientSecret`/`client_secret`, `webhookSecret`/`webhook_secret`, `privateKey`/`private_key`, and `password`
- Account and authentication secrets: `accountNumber` and `twoFactorSecret`

`logError` also strips these fields from its `errorInfo` argument before logging, including nested objects. Redacted values appear as `[Redacted]`.

### Error Tracking (Sentry)

```typescript
// sentry.client.config.ts
import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_APP_ENV,
  tracesSampleRate: 0.1,
})
```

### Health Checks

```typescript
// app/api/health/route.ts
export async function GET() {
  const checks = {
    database: await checkDatabase(),
    stellar: await checkStellarHorizon(),
  }
  
  const healthy = Object.values(checks).every(c => c.status === 'ok')
  return Response.json(checks, { status: healthy ? 200 : 503 })
}
```

---

## 8. Disaster Recovery

### Backup Strategy

| Data | Backup Frequency | Retention | Method |
|------|------------------|-----------|--------|
| **PostgreSQL** | Continuous | 7 days (PITR) | Neon automatic |
| **Configs** | On change | Unlimited | Git |
| **Secrets** | On change | N/A | Vercel encrypted |

### Recovery Procedures

```bash
# 1. Database restore (Neon)
# Use Neon console → Branches → Restore to point in time

# 2. Rollback deployment (Vercel)
vercel rollback [deployment-url]
```

---

## 9. Cost Optimization

### Estimated Monthly Costs (MVP → Scale)

| Service | MVP (< 1K users) | Growth (< 10K) | Scale (< 100K) |
|---------|------------------|----------------|----------------|
| **Vercel** | Free | $20/mo | $150/mo |
| **Neon** | Free | $19/mo | $69/mo |
| **Privy** | Free (< 1K MAU) | $99/mo | $299/mo |
| **Stellar Horizon** | Free | Free | Free |
| **Sentry** | Free | Free | $26/mo |
| **Cloudflare** | Free | Free | $20/mo |
| **Resend** | Free | $20/mo | $50/mo |
| **Total** | **$0** | **~$180/mo** | **~$615/mo** |

---

## Quick Start Checklist

### Day 1: Foundation
- [ ] Create Vercel project, connect GitHub repo
- [ ] Create Neon project, run initial migrations
- [ ] Create Privy app, enable Google login
- [ ] Set up all environment variables
- [ ] Deploy "Hello World" to verify pipeline

### Week 1: Core Features
- [ ] Integrate Privy (Google auth + embedded wallets)
- [ ] Build dashboard UI
- [ ] Implement invoice creation
- [ ] Set up Sentry error tracking

### Week 2: Integrations
- [ ] Set up MoonPay sandbox (onramp)
- [ ] Apply for Yellow Card API access (offramp)
- [ ] Configure webhook handlers
- [ ] Configure rate limiting policies (`lib/rate-limit.ts`)

### Week 3: Production Readiness
- [ ] Configure Cloudflare (DNS + WAF)
- [ ] Set up GitHub Actions CI/CD
- [ ] Create staging environment
- [ ] Security audit

---

**Document Version:** 2.0  
**Last Updated:** December 2024  
**Author:** FreelancerPay402 DevOps
