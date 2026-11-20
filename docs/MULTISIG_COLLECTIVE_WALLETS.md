# Multi-Sig Collective Wallets (Teams)

## Overview
Collective wallets allow agencies/partnerships to co-manage a shared Stellar USDC wallet using an **M-of-N approval policy** (with optional signer weights). Any proposal (withdrawal / transfer) is recorded and only executed once approvals meet the wallet threshold.

This implementation uses **application-level approvals** (tracked in Postgres) and only broadcasts a Stellar transaction once fully authorized. Execution is protected with an **atomic DB lock** (`pending -> executing`) to prevent double-sends under concurrent approvals.

All endpoints live under `/api/collective-wallets` and require an authenticated user (Bearer token). Only wallet signers can view proposals, sign, or manage signers.

## Data Model (Postgres)
- `collective_wallets`: team wallet metadata + threshold + Stellar address (+ optional encrypted secret key).
- `wallet_signers`: membership list (user ↔ wallet) with signing `weight` (max 255 per signer, max 20 signers per wallet).
- `multisig_proposals`: pending transfers (destination, amount, memo, status, expiration, execution metadata).
- `proposal_signatures`: per-user approval records (unique per proposal+signer).

## API Endpoints

### Create wallet
`POST /api/collective-wallets`

Body:
```json
{
  "name": "Acme Agency",
  "threshold": 2,
  "stellarAddress": "G...",
  "secretKey": "S...",
  "signers": [
    { "userId": "userA", "weight": 1 },
    { "userId": "userB", "weight": 1 },
    { "userId": "userC", "weight": 1 }
  ]
}
```

Notes:
- `secretKey` is optional. If supplied, the Stellar address is derived from it (and must match `stellarAddress` when both are given). It is encrypted at rest (see `ENCRYPTION_KEY` below) and never returned by the API. If omitted, a new keypair is generated.
- The authenticated creator is automatically enrolled as a signer with weight 1 unless they list themselves with another weight.
- `threshold` is an integer between 1 and the number of initial signers, and is compared against the **sum of signer weights**.

### List proposals
`GET /api/collective-wallets/[id]/proposals`

Lists proposals for the wallet (signers only). Returns `{ proposals, threshold }`.

`GET /api/collective-wallets/[id]/proposals/pending` lists pending proposals awaiting the caller's signature (excludes proposals the caller already signed, expired, or executed ones).

### Propose a transfer
`POST /api/collective-wallets/[id]/proposals`

Body:
```json
{ "destinationAddress": "G...", "amountUsdc": "100.00", "memo": "Optional", "expiresInHours": 72 }
```

Behavior:
- Requires proposer to be a wallet signer.
- `amountUsdc` accepts a string or number (positive, max 6 decimal places).
- `destinationAddress` must be a valid 56-character Stellar `G...` address and cannot be the wallet itself.
- `memo` is optional, max 28 bytes (Stellar text memo limit).
- `expiresInHours` defaults to **72** and is capped at 168 (7 days).
- Creates a `multisig_proposals` row with `status: 'pending'`.

### Sign a proposal (and execute when threshold met)
`POST /api/collective-wallets/[id]/proposals/[proposalId]/sign`

Body: none required.

Behavior:
- Requires caller to be a wallet signer.
- Records a `proposal_signatures` row (idempotent if the user already signed).
- Computes approval progress as **sum of signer weights** for recorded signatures against `wallet.threshold`.
- When the threshold is met, the proposal is atomically claimed (`pending -> executing`) and the Stellar USDC payment is submitted; the proposal then becomes `executed` with `stellarTxHash` (or `permanently_failed` on broadcast failure).

### Proposal status helpers
- `GET /api/collective-wallets/[id]/proposals/[proposalId]/status` — current proposal status.
- `GET /api/collective-wallets/[id]/proposals/[proposalId]/signatures` — recorded signatures.
- `GET /api/collective-wallets/[id]/proposals/[proposalId]/signature-weight` — approval progress vs threshold.
- `GET /api/collective-wallets/[id]/proposals/[proposalId]/broadcast-status` — on-chain broadcast record for executed proposals.
- `POST /api/collective-wallets/[id]/proposals/[proposalId]/cancel` — cancel a proposal (proposer only; not allowed once `executing`, `executed`, or `cancelled`).
- `POST /api/collective-wallets/[id]/proposals/[proposalId]/retry` — retry a failed execution.
- `POST /api/collective-wallets/[id]/proposals/expire-sweep` — mark stale pending proposals as `expired`.

### Manage signers
- `GET /api/collective-wallets/[id]/signers` — list signers, `totalWeight`, and `threshold` (signers only).
- `POST /api/collective-wallets/[id]/signers` — add a signer `{ "userId": "...", "weight": 1 }` (existing signers only; total weight after adding must stay >= threshold, max 20 signers).
- `DELETE /api/collective-wallets/[id]/signers/[signerId]` — remove a signer (blocked while the signer has pending signatures / when it would drop total weight below threshold).

### Update threshold
`PATCH /api/collective-wallets/[id]/threshold`

Body:
```json
{ "threshold": 2, "approvals": ["userIdOrSignerId", "..."] }
```

Behavior:
- `threshold` (or `newThreshold`) must be an integer >= 1 and cannot exceed the sum of current signer weights.
- Requires sign-off from a **majority of existing signers** (`floor(n/2) + 1`); the caller counts as one approver, additional approver IDs can be supplied via `approvals` / `signOffs` / `signerIds`.

### Audit log
`GET /api/collective-wallets/[id]/audit-log`

Chronological audit trail of proposal lifecycle events (`created`, `signed`, `executed`, `cancelled`, `expired`). Signers only; supports cursor-based pagination (`limit` up to 100, default 50).

## Expiration
- Proposals expire after `expiresInHours` (default **72h**, max 7 days) and cannot be executed once expired.
- `POST .../proposals/expire-sweep` marks stale proposals `expired`; expiration is also applied opportunistically on reads.

## Environment Variables
- `ENCRYPTION_KEY`: used to encrypt/decrypt stored wallet secret keys (see `lib/crypto.ts`).
- Stellar keys (`STELLAR_NETWORK`, `STELLAR_FUNDING_WALLET_SECRET`, etc.) are used to submit the executed payments.

## Testing Checklist (2-of-3)
1. Create a wallet with signers A/B/C and `threshold=2`.
2. A creates a proposal for a `$100` transfer → proposal is `pending`.
3. B signs → progress becomes `1 of 2 approved`, still `pending`.
4. C signs → execution triggers immediately, proposal becomes `executed` with `stellarTxHash`.
5. D (not a signer) attempts to sign → API returns `403 Forbidden`.
