# LancePay 💸

**Instant international payments for Nigerian freelancers — powered by Stellar and stablecoins.**

LancePay enables freelancers to receive payments from global clients in minutes, not days, with fees under 1%. Blockchain complexity is completely abstracted — users see invoices, balances, and bank withdrawals, nothing else.

---

## 🎯 What We're Building

A fintech platform that solves the biggest pain point for Nigerian freelancers: **receiving international payments quickly and cheaply**.

### The Problem
- Traditional payment methods (PayPal, Wise) have high fees (5-10%) and slow settlement (3-7 days)
- Nigerian freelancers lose significant portions of their earnings to fees and exchange rate markups
- Crypto solutions are too complex for non-technical users

### Our Solution
- **Create invoice** → Get shareable payment link
- **Client pays** → Card payment converts to USDC on Stellar
- **Instant settlement** → Funds arrive in 3-5 seconds
- **Withdraw to bank** → Convert to NGN via Yellow Card, instant bank transfer
- **Keep 99%+ of earnings** → Fees under 1%

**Zero crypto knowledge required** — users never see wallets, private keys, or blockchain jargon.

---

## 🛠️ Tech Stack

- **Frontend:** Next.js 16 (App Router), React 19, Tailwind CSS v4
- **Backend:** Next.js API routes, Prisma ORM, PostgreSQL (Neon)
- **Authentication:** Privy (OAuth + embedded Stellar wallets)
- **Blockchain:** Stellar Network (USDC stablecoin)
- **Payments:** MoonPay (on-ramp), Yellow Card (off-ramp to Nigerian banks)
- **Email:** Resend

---

## 🌟 Why Stellar?

- ✅ **3-5 second settlement** with fees <$0.01
- ✅ **Yellow Card integration** — Direct off-ramp to Nigerian banks in 20+ African countries
- ✅ **475,000+ on/off-ramp access points** worldwide
- ✅ **Battle-tested** — Used by MoneyGram, Onafriq, and major African payment providers
- ✅ **Lower costs** — ~$0.75 per wallet (XLM reserves) vs building custom infrastructure

## 📁 Project Structure

```
├── app/              # Next.js app router (pages & API routes)
├── components/       # Reusable UI components
├── lib/              # Utilities, configs, and helpers
├── hooks/            # Custom React hooks
├── prisma/           # Database schema and migrations
├── docs/             # Technical documentation
└── public/           # Static assets
```

---

## 📖 Documentation

For contributors and developers:

- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — How to contribute to this project
- **[Code Style Guide](./docs/CODE_STYLE.md)** — Code standards and best practices
- **[Module Architecture](./docs/MODULES.md)** — Architecture guide covering app routes, components, hooks, and lib domain services

---

## 🔄 How It Works

### Payment Flow

```
1. Freelancer creates invoice → Unique payment link generated
2. Client opens link → No account needed
3. Client pays via card → MoonPay converts to USDC on Stellar
4. Payment arrives → Freelancer's embedded wallet (3-5 seconds)
5. Email notification → Freelancer sees balance update
6. Freelancer withdraws → Yellow Card converts USDC → NGN
7. Funds arrive → Nigerian bank account (instant)
```

### Technical Flow

```
Client Card Payment
    ↓
MoonPay (Fiat → USDC on Stellar)
    ↓
Freelancer's Stellar Wallet (Privy embedded)
    ↓
Yellow Card API (USDC → NGN)
    ↓
Nigerian Bank Account
```

**Key Benefits:**
- Freelancers keep **99%+ of earnings** (fees <1%)
- Payments arrive in **minutes, not days**
- No crypto knowledge required — just invoices and bank transfers

## 📄 License

This project is proprietary. All rights reserved.

---

Built with ❤️ for Nigerian freelancers.

---

## 🕰️ Cron Jobs

This project uses Vercel Cron Jobs to automate maintenance tasks.

**Auto-Cancellation of Overdue Invoices:**
Runs daily at 2:00 AM UTC (`0 2 * * *`). It automatically cancels unpaid invoices that meet the following criteria:
- **Status:** Pending
- **Due Date:** More than 90 days ago
- **Exclusions:** Invoices with active escrow, active disputes, or `doNotAutoCancel: true` are never auto-cancelled.

To manually test the auto-cancellation cron locally, run:
```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" http://localhost:3000/api/cron/cancel-overdue-invoices
```
