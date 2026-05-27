# LancePay 💸

> **Instant international payments for Nigerian freelancers — powered by Stellar and stablecoins.**

[![License: Proprietary](https://img.shields.io/badge/License-Proprietary-red.svg)](./LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![Stellar](https://img.shields.io/badge/Stellar-Network-blue?logo=stellar)](https://stellar.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Neon-336791?logo=postgresql)](https://neon.tech/)

LancePay lets freelancers receive payments from global clients in **minutes, not days**, with fees under **1%**. All blockchain complexity is completely abstracted — users only ever see invoices, balances, and bank withdrawals.

---

## 📌 Table of Contents

- [The Problem](#-the-problem)
- [Our Solution](#-our-solution)
- [How It Works](#-how-it-works)
- [Tech Stack](#️-tech-stack)
- [Why Stellar?](#-why-stellar)
- [Project Structure](#-project-structure)
- [Getting Started](#-getting-started)
- [Environment Variables](#-environment-variables)
- [Contributing](#-contributing)
- [Cron Jobs](#️-cron-jobs)
- [Documentation](#-documentation)
- [License](#-license)

---

## 😤 The Problem

Nigerian freelancers face a painful reality when getting paid internationally:

| Method | Fees | Settlement Time |
|--------|------|-----------------|
| PayPal | 5–10% | 3–7 days |
| Wise | 3–6% | 1–3 days |
| Crypto (DIY) | <1% | Minutes — but too complex |
| **LancePay** | **<1%** | **3–5 seconds** |

Traditional platforms eat into earnings with high fees and slow settlement. DIY crypto is cheap but inaccessible to non-technical users. **LancePay bridges that gap.**

---

## ✅ Our Solution

```
Create invoice  →  Share link  →  Client pays  →  Funds arrive in seconds  →  Withdraw to bank
```

1. **Create an invoice** — Freelancer generates a shareable payment link
2. **Client pays** — No crypto account needed; client pays by card
3. **Instant settlement** — MoonPay converts card payment to USDC on Stellar
4. **Funds arrive** — Freelancer's embedded wallet receives USDC in 3–5 seconds
5. **Withdraw to NGN** — Yellow Card converts USDC → NGN and sends to bank account

**Zero crypto knowledge required** — users never see wallets, private keys, or blockchain jargon.

---

## 🔄 How It Works

### Payment Flow

```
1. Freelancer creates invoice  →  Unique payment link generated
2. Client opens link           →  No account needed
3. Client pays via card        →  MoonPay converts to USDC on Stellar
4. Payment arrives             →  Freelancer's embedded Stellar wallet (3–5 sec)
5. Email notification          →  Freelancer sees balance update
6. Freelancer withdraws        →  Yellow Card converts USDC → NGN
7. Funds arrive                →  Nigerian bank account (instant)
```

### Technical Flow

```
Client Card Payment
        ↓
  MoonPay API
  (Fiat → USDC on Stellar)
        ↓
  Freelancer's Stellar Wallet
  (Privy embedded wallet)
        ↓
  Yellow Card API
  (USDC → NGN conversion)
        ↓
  Nigerian Bank Account
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Next.js 16 (App Router), React 19, Tailwind CSS v4 |
| **Backend** | Next.js API Routes, Prisma ORM |
| **Database** | PostgreSQL (Neon serverless) |
| **Authentication** | Privy (OAuth + embedded Stellar wallets) |
| **Blockchain** | Stellar Network (USDC stablecoin) |
| **On-Ramp** | MoonPay (card → USDC) |
| **Off-Ramp** | Yellow Card (USDC → NGN → bank) |
| **Email** | Resend |
| **Deployment** | Vercel |

---

## 🌟 Why Stellar?

| Feature | Benefit |
|---------|---------|
| ⚡ **3–5 second settlement** | Fastest finality of any public blockchain |
| 💰 **Fees < $0.01** | Near-zero transaction costs |
| 🏦 **Yellow Card integration** | Direct off-ramp to banks in 20+ African countries |
| 🌍 **475,000+ access points** | Global on/off-ramp coverage |
| 🔒 **Battle-tested** | Powers MoneyGram, Onafriq, and major African fintechs |
| 📉 **Low infrastructure cost** | ~$0.75 per wallet vs building custom rails |

---

## 📁 Project Structure

```
lancepay/
├── app/
│   ├── api/
│   │   ├── bank-accounts/       # Bank account management
│   │   ├── cron/                # Scheduled jobs
│   │   ├── exchange-rate/       # FX rate endpoints
│   │   ├── invoices/            # Invoice CRUD & payment
│   │   ├── pay/                 # Payment processing
│   │   ├── routes-b/            # API v2 routes
│   │   ├── routes-d/            # API v4 routes
│   │   ├── transactions/        # Transaction history
│   │   ├── user/                # User profile & settings
│   │   ├── webhooks/            # MoonPay & Privy webhooks
│   │   └── withdrawals/         # Off-ramp to bank
│   └── (pages)/                 # Next.js App Router pages
├── components/                  # Reusable UI components
├── hooks/                       # Custom React hooks
├── lib/                         # Utilities, configs, helpers
│   ├── stellar.ts               # Stellar SDK wrapper
│   ├── assets.ts                # Asset definitions
│   └── ...
├── prisma/                      # Database schema & migrations
├── docs/                        # Technical documentation
└── public/                      # Static assets
```

---

## 🚀 Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL database (or [Neon](https://neon.tech) account)
- [Privy](https://privy.io) account
- [MoonPay](https://moonpay.com) API keys
- [Yellow Card](https://yellowcard.io) API keys

### Installation

```bash
# 1. Clone the repo
git clone https://github.com/davedumto/LancePay.git
cd LancePay

# 2. Install dependencies
npm install

# 3. Set up environment variables
cp .env.example .env.local
# Fill in your keys (see Environment Variables below)

# 4. Set up the database
npx prisma migrate dev

# 5. Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the app.

---

## 🔐 Environment Variables

Create a `.env.local` file in the root directory with the following:

```env
# Database
DATABASE_URL=

# Privy (Authentication + Wallets)
NEXT_PUBLIC_PRIVY_APP_ID=
PRIVY_APP_SECRET=

# MoonPay (On-ramp)
MOONPAY_API_KEY=
MOONPAY_SECRET_KEY=

# Yellow Card (Off-ramp)
YELLOW_CARD_API_KEY=
YELLOW_CARD_SECRET_KEY=

# Resend (Email)
RESEND_API_KEY=

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
CRON_SECRET=
```

> ⚠️ Never commit `.env.local` to version control.

---

## 🤝 Contributing

We welcome contributions! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide.

### Quick Start for Contributors

```bash
# Fork and clone the repo
git clone https://github.com/YOUR_USERNAME/LancePay.git

# Create a feature branch
git checkout -b feat-your-feature-name

# Make changes, then commit
git commit -m "feat: describe your change"

# Push and open a PR
git push origin feat-your-feature-name
```

**Branch naming conventions:**
- `feat-` — new features
- `fix-` — bug fixes
- `docs-` — documentation updates
- `refactor-` — code refactoring
- `chore-` — maintenance tasks

---

## 🕰️ Cron Jobs

LancePay uses **Vercel Cron Jobs** to automate maintenance tasks.

### Auto-Cancellation of Overdue Invoices

- **Schedule:** Daily at 2:00 AM UTC (`0 2 * * *`)
- **Action:** Cancels unpaid invoices that are overdue by more than 90 days
- **Exclusions:** Invoices with active escrow, active disputes, or `doNotAutoCancel: true` are never auto-cancelled

**Test locally:**
```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" \
  http://localhost:3000/api/cron/cancel-overdue-invoices
```

---

## 📖 Documentation

| Document | Description |
|----------|-------------|
| [CONTRIBUTING.md](./CONTRIBUTING.md) | How to contribute to this project |
| [CODE_STYLE.md](./docs/CODE_STYLE.md) | Code standards and best practices |
| [DEVOPS.md](./docs/DEVOPS.md) | Deployment and infrastructure guide |
| [FEE_QUOTE_API.md](./docs/FEE_QUOTE_API.md) | Fee quote API reference |
| [MODULES.md](./docs/MODULES.md) | Module architecture overview |
| [MULTISIG_COLLECTIVE_WALLETS.md](./docs/MULTISIG_COLLECTIVE_WALLETS.md) | Multisig wallet documentation |

---

## 📄 License

This project is proprietary. All rights reserved.

---

<div align="center">
  Built with ❤️ for Nigerian freelancers.<br/>
  <strong>LancePay</strong> — Keep more of what you earn.
</div>
