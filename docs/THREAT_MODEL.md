# LancePay Threat Model

> What we protect, where trust boundaries sit, what controls exist today,
> and what reviewers must check before merging money-moving changes.

Last reviewed against `main`. Issue numbers reference open GitHub issues
for known gaps; close them and update this document when they land.

---

## 1. Assets

| Asset | Where it lives | Impact if compromised |
|-------|---------------|------------------------|
| User funds (USDC on Stellar, NGN payouts) | Stellar accounts, `UserWithdrawalBalance` ledger, offramp provider | Direct financial loss |
| Embedded wallet keys | Privy (custodial); `Wallet.privateKey`-style fields encrypted at rest via `lib/crypto.ts` | Full wallet drain |
| Collective wallet secrets | `CollectiveWallet.encryptedSecretKey` (`prisma/schema.prisma`) | Multisig drain if threshold bypassed |
| Funding wallet | `STELLAR_FUNDING_WALLET_SECRET` → `lib/stellar-funding.ts` | Can fund/drain sponsored accounts |
| Sponsor / delegate signers | `STELLAR_SPONSOR_SECRET`, `STELLAR_FUNDING_SECRET`, `WITHDRAWAL_DELEGATE_SECRET_KEY` | Reserve sponsorship abuse, withdrawal signing |
| PII & KYC data | `User`, KYC applications, bank accounts (encrypted fields) | Privacy breach, regulatory exposure |
| Audit trail integrity | `AuditLog` signed with `AUDIT_SECRET`/`AUDIT_SIGNING_SECRET` (`lib/audit.ts`) | Undetectable tampering |
| API credentials | `api_keys` table, hashed | Account takeover via API |
| Webhook secrets | Per-provider env secrets (see §4) | Forged payment/status events |

## 2. Trust Boundaries & Entry Points

### 2.1 Public HTTP surface

Every route under `app/api/**` is a boundary. Money-moving routes
additionally cross into Stellar (Horizon/Soroban), the offramp provider,
anchors (SEP-24), and the database. Authentication is `verifyAuthToken`
(`lib/auth.ts`) or route-specific checks; authorization helpers live in
`lib/authorization.ts`.

### 2.2 Inbound webhooks (`app/api/webhooks/**`)

| Endpoint | Provider | Authentication control | File |
|----------|----------|------------------------|------|
| `POST /api/webhooks/moonpay` | MoonPay | Svix-style signature `moonpay-signature-v2`, HMAC verify via `verifyMoonPaySignatureV2`, `MOONPAY_WEBHOOK_TOLERANCE_SECONDS` replay window, raw body required | `app/api/webhooks/moonpay/route.ts`, `lib/moonpay-signature.ts` |
| `POST /api/webhooks/offramp` | Yellow Card offramp | HMAC-SHA256 over raw body vs `OFFRAMP_WEBHOOK_SECRET`, `timingSafeEqual`, signature checked before JSON parse | `app/api/webhooks/offramp/route.ts` |
| `POST /api/webhooks/privy` | Privy | Svix headers (`svix-id/timestamp/signature`), HMAC-SHA256 over `id.timestamp.body`, `timingSafeEqual` per `v1` signature | `app/api/webhooks/privy/route.ts`, `lib/privy-webhook-verify.ts` |
| `POST /api/routes-d/integrations/circle/deposit-callback` | Circle | Shared-secret header `x-circle-signature` vs `CIRCLE_WEBHOOK_SECRET` | `app/api/routes-d/integrations/circle/deposit-callback/route.ts` |
| `POST /api/routes-d/integrations/circle/payout-webhook` | Circle | User bearer auth (`verifyAuthToken`) — manual/simulated path | `app/api/routes-d/integrations/circle/payout-webhook/route.ts` |
| `POST /api/routes-d/integrations/persona/callback` | Persona (KYC) | `verifyAuthToken` session auth | `app/api/routes-d/integrations/persona/callback/route.ts` |
| `POST /api/routes-d/integrations/sumsub/callback` | Sumsub (KYC) | `verifyAuthToken` session auth | `app/api/routes-d/integrations/sumsub/callback/route.ts` |
| `POST /api/routes-d/integrations/webhooks/inbound/[id]` (+ `rotate-secret`) | User-defined outbound webhooks | Inbound delivery endpoints; per-endpoint signing secrets, rotation route | `app/api/routes-d/integrations/webhooks/inbound/[id]/rotate-secret/route.ts` |
| `POST /api/webhook-simulator/trigger` | Internal testing | Verify it is disabled/gated outside development | `app/api/webhook-simulator/trigger/route.ts` |

### 2.3 Cron endpoints

| Endpoint | Trigger | Control | File |
|----------|---------|---------|------|
| `POST /api/cron/cancel-overdue-invoices` | Vercel Cron / scheduler | `Authorization: Bearer $CRON_SECRET` exact match | `app/api/cron/cancel-overdue-invoices/route.ts` |
| `GET /api/routes-d/cron/catalog` | Admin UI | `verifyAuthToken` + admin check; catalog/metadata only | `app/api/routes-d/cron/catalog/route.ts` |

> Any new cron route MUST check `CRON_SECRET` (or an equivalent
> platform-verified credential) before doing work — see checklist §6.

### 2.4 Money-movement paths

- **Withdrawals**: `POST /api/withdrawals` → ledger reservation
  (`lib/withdrawal-ledger.ts`) → `debitDelegatedUSDC`
  (`lib/stellar.ts`) → `initiateOfframp` (`lib/offramp.ts`).
- **Payout batches / collective wallets**: multisig proposal → sign →
  `submitMultisigPaymentWithRetry` → Horizon submission
  (`app/api/payout-batches/**`, `app/api/collective-wallets/**`,
  `app/api/onchain/multisig-broadcasts/route.ts`).
- **Wallet funding**: `lib/stellar-funding.ts` creates/funds accounts
  with starting XLM; USDC trustline bootstrap sponsored via
  `app/api/stellar/trustlines/usdc/bootstrap/route.ts`.
- **Anchor sessions**: SEP-24 interactive flows (`lib/sep24.ts`,
  `lib/anchors.ts`) for MoneyGram/Yellowcard cash-out.

## 3. Key Management

| Secret | Purpose | Storage & handling | Known gaps |
|--------|---------|--------------------|------------|
| `ENCRYPTION_KEY` | AES key for `lib/crypto.ts` field encryption (bank details, secrets at rest) | Env var only; must be 32 bytes | **Gap:** `lib/crypto.ts` falls back to a hardcoded `'default_secret_key_must_be_32_bytes!'` when unset — tracked by #1829 (require in production). Legacy AES-CBC writes remain readable; GCM v2 envelopes tracked by #1830/#1831 |
| `AUDIT_SECRET` / `AUDIT_SIGNING_SECRET` | HMAC-sign audit log entries (`lib/audit.ts`) | Env var; signing key never leaves server | Rotate procedure undocumented |
| `STELLAR_FUNDING_WALLET_SECRET` | Funding wallet ed25519 seed (`lib/stellar-funding.ts`) | Env var; validated as ed25519 secret seed at startup; never logged | Single hot wallet — compromise drains its XLM/USDC |
| `STELLAR_SPONSOR_SECRET` / `STELLAR_FUNDING_SECRET` | Pays reserve+fees for trustline sponsorship (`bootstrap/route.ts`) | Env var; **falls back to `Keypair.random()` when unset**, producing an unfunded sponsor that fails opaquely | Missing-secret fallback should fail fast instead — candidate hardening issue |
| `WITHDRAWAL_DELEGATE_SECRET_KEY` | Signs delegated USDC debits (`debitDelegatedUSDC`) | Env var; checked per request in withdrawals route | Broad signing power — scope to treasury payments only |
| `PRIVY_APP_SECRET` / `PRIVY_WEBHOOK_SECRET` | Privy API auth; Svix webhook verification | Env vars | Webhook timestamp tolerance tracked by #1839 |
| `MOONPAY_WEBHOOK_KEY`, `OFFRAMP_WEBHOOK_SECRET`, `CIRCLE_WEBHOOK_SECRET`, anchor `*_CLIENT_SECRET`s, `OFFRAMP_API_KEY/SECRET`, `PAYSTACK_SECRET_KEY`, `EXCHANGE_RATE_API_KEY`, `RESEND_API_KEY`, `CRON_SECRET`, `AUTH_SECRET` | Provider auth / webhook verification / cron | Env vars; never committed; `.env.example` documents names only | `CRON_SECRET` compared with `!==` (non-constant-time) in `cancel-overdue-invoices` — low risk, worth `timingSafeEqual` |

### Key handling rules

- Secrets live only in environment variables / the platform secret
  manager — never in the repo, logs, or API responses.
- Stellar secret seeds are validated (`StrKey.isValidEd25519SecretSeed`)
  before use in `lib/stellar-funding.ts`.
- Webhook secrets are compared with `crypto.timingSafeEqual` where the
  comparison is byte-wise (`lib/crypto.ts`, `lib/privy-webhook-verify.ts`,
  `lib/moonpay-signature.ts`); plain `===`/`!==` comparisons are a gap.
- `lib/crypto.ts` is the only module that should read `ENCRYPTION_KEY`.

## 4. Per-Boundary Controls & Gaps

### Webhook ingress

| Boundary | Controls | Gaps / open issues |
|----------|----------|--------------------|
| MoonPay | Signature over raw body before parse; timestamp tolerance env; amount/currency validated before marking invoices paid (#1920 merged) | Verify tolerance is enforced, not just configured |
| Offramp (Yellow Card) | HMAC-SHA256 + `timingSafeEqual`; raw body; signature before parse | Replay protection relies on provider nonce/dedup — confirm downstream idempotency |
| Privy | Svix HMAC `v1` signatures, constant-time compare | **Gap:** no timestamp freshness window → replay window open; tracked by #1839 |
| Circle callbacks | Shared-secret header | Plain `===` comparison; no payload signature — acceptable only if endpoint is not internet-exposed |
| Persona/Sumsub callbacks | Session auth | Callback authenticity depends on provider→app auth; verify server-to-server tokens where available |
| Inbound user webhooks | Per-endpoint secrets, rotation route | Ensure rotated secrets invalidate in-flight deliveries |
| Webhook simulator | Test-only | Confirm it is inert in production builds |

### Embedded wallet custody

- Privy embedded wallets hold user keys; LancePay never sees seed phrases.
- `Wallet`/custody records store encrypted material via `lib/crypto.ts`.
- **Gap:** `ENCRYPTION_KEY` has an insecure fallback (#1829) and legacy
  CBC ciphertext lacks authentication (#1830/#1831).

### Funding wallet (`lib/stellar-funding.ts`)

- Creates accounts with starting XLM; retries with backoff
  (`funding retry scheduled` path).
- **Gap:** sponsor secret falls back to `Keypair.random()` — fail fast
  instead.

### Collective wallets

- `CollectiveWallet.encryptedSecretKey` encrypted at rest;
  `WalletSigner` weights + `MultisigProposal` threshold govern signing;
  proposals expose retry/sign routes under
  `app/api/collective-wallets/[id]/proposals/**`.
- **Gap:** broadcast retries must never resubmit while a prior tx hash
  may still land — tracked by #1861 (pending-confirmation handling).

### Admin access

- Admin identity unified in `isAdmin` (`lib/authorization.ts`):
  `User.role` ∈ {admin, superadmin, super_admin} OR `ADMIN_EMAILS`
  break-glass (#1838).
- Admin routes under `app/api/admin/**`, `app/api/routes-d/admin/**`
  require the helper; audit access via `checkAuditLogAccess`.
- **Gap:** `ADMIN_EMAILS` env is a break-glass path — keep it minimal
  and review membership quarterly.

### AuthN/AuthZ

- `verifyAuthToken` returns `null` for missing users (#1836); session
  revocation enforced.
- 2FA TOTP replay protection via `User.lastTotpStep` (#1837).
- Rate limiting: `lib/rate-limit.ts` + `lib/client-ip.ts` — platform IP
  headers preferred, XFF trusted only `TRUSTED_PROXY_HOPS` hops (#1847);
  shared Redis store optional via `RATE_LIMIT_STORE` (#1850).

## 5. Data Flows Worth Re-Reviewing

1. **Withdrawal**: ledger reserve → on-chain debit → offramp payout.
   Each hop can fail independently; ambiguous outcomes must reconcile by
   tx hash, not blind retry (#1861, #1870).
2. **Ledger drift**: `availableUsdc` vs on-chain USDC — reconciled +
   audited + admin alert (#1872).
3. **Bulk invoice jobs**: invoice numbers from CSPRNG + P2002 retry
   (#1879) — webhook lookups depend on uniqueness.
4. **SEP-24 anchors**: direction must match endpoint (deposit vs
   withdraw) (#1868).

## 6. Reviewer Checklist — New Money-Moving Routes

Before approving any route that moves funds or changes balances:

- [ ] AuthN **and** AuthZ checked (`verifyAuthToken` + `isAdmin`/ownership
      where applicable); no reliance on client-supplied identity.
- [ ] Input validated with zod/`parsePositiveMoney`; amounts use
      `Decimal`, never raw floats.
- [ ] Idempotency: unique key or dedup on retries; ambiguous external
      outcomes reconcile by transaction hash before resubmission.
- [ ] Secrets read from env only; never logged, never in responses;
      comparisons use `timingSafeEqual`.
- [ ] Webhook handlers verify signatures over the **raw** body before
      parsing and enforce replay windows.
- [ ] Cron routes check `CRON_SECRET`.
- [ ] Ledger writes are atomic (`updateMany` conditional / `$transaction`)
      and audited (`lib/audit.ts` / `WithdrawalLedgerAudit`).
- [ ] Errors are typed (`Error` subclasses), don't leak internals, and
      ambiguous failures are not marked as definitive failures.
- [ ] Tests cover happy path + the failure modes above; docs updated
      (`docs/FEE_QUOTE_API.md`, `docs/CODE_STYLE.md`, this file if a new
      boundary is added).
