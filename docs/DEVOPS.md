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
          │      NEON       │               │     UPSTASH     │               │    ALCHEMY      │
          │  (PostgreSQL)   │               │     (Redis)     │               │   (Base RPC)    │
          │   Serverless    │               │  Rate Limiting  │               │  Blockchain     │
          └─────────────────┘               │  Session Cache  │               └─────────────────┘
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
| **Cache/Rate Limit** | Upstash Redis | Serverless, pay-per-request |
| **Blockchain RPC** | Alchemy | Reliable, enhanced APIs, webhooks |
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
# BLOCKCHAIN
# ═══════════════════════════════════════════════════════════════
ALCHEMY_API_KEY=your-alchemy-key
NEXT_PUBLIC_BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}
USDC_CONTRACT_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

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
# CACHE (Upstash Redis)
# ═══════════════════════════════════════════════════════════════
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=xxx

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
import { neonConfig } from '@neondatabase/serverless'

// Enable connection pooling for serverless
neonConfig.fetchConnectionCache = true

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
        
        // Default chain
        defaultChain: base,
        supportedChains: [base],
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

### Client IP resolution and trusted proxies

`lib/client-ip.ts` is the single resolver used by both the rate limiter
(`lib/rate-limit.ts`) and audit metadata (`lib/audit.ts`). Resolution order:

1. `x-real-ip` — set by the hosting platform edge; not client-spoofable on
   Vercel.
2. `cf-connecting-ip` — set by Cloudflare; trusted only when the request
   actually arrives through Cloudflare.
3. `x-vercel-forwarded-for`, then `x-forwarded-for` — only the hop at index
   `hops.length - TRUSTED_PROXY_HOPS` is trusted, because every proxy in front
   of the app appends the address it observed. The left-most entries are
   client-controlled and must never be used directly.

**Deployment assumption:** set `TRUSTED_PROXY_HOPS` to the number of trusted
reverse proxies in front of the Next.js server (e.g. `1` for a single
load balancer, `2` for Cloudflare + load balancer). If your platform injects a
dedicated client-IP header (Cloudflare, Vercel), steps 1–2 already cover it and
`TRUSTED_PROXY_HOPS` only matters for generic `x-forwarded-for` setups.

### Upstash Redis Usage

```typescript
// lib/redis.ts
import { Redis } from '@upstash/redis'

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

// Rate limiting
export async function rateLimit(ip: string, limit = 10, window = 60) {
  const key = `rate_limit:${ip}`
  const current = await redis.incr(key)
  if (current === 1) {
    await redis.expire(key, window)
  }
  return current <= limit
}
```

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
| **Rate Limiting** | Upstash Redis (10 req/min for auth, 100/min for API) |
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
// Cache frequently accessed data
export async function getExchangeRate() {
  const cached = await redis.get('exchange_rate:USD_NGN')
  if (cached) return JSON.parse(cached)
  
  const rate = await fetchFromYellowCard()
  await redis.setex('exchange_rate:USD_NGN', 300, JSON.stringify(rate))
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
    redis: await checkRedis(),
    blockchain: await checkBlockchainRPC(),
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
| **Upstash** | Free | $10/mo | $50/mo |
| **Alchemy** | Free | Free | $49/mo |
| **Sentry** | Free | Free | $26/mo |
| **Cloudflare** | Free | Free | $20/mo |
| **Resend** | Free | $20/mo | $50/mo |
| **Total** | **$0** | **~$170/mo** | **~$715/mo** |

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
- [ ] Add rate limiting with Upstash

### Week 3: Production Readiness
- [ ] Configure Cloudflare (DNS + WAF)
- [ ] Set up GitHub Actions CI/CD
- [ ] Create staging environment
- [ ] Security audit

---

**Document Version:** 2.0  
**Last Updated:** December 2024  
**Author:** FreelancerPay402 DevOps
