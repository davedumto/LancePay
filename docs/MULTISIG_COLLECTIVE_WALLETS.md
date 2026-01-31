# Multi-Sig Collective Wallets (Teams)

## Overview
Collective wallets allow agencies/partnerships to co-manage a shared Stellar USDC wallet using an **M-of-N approval policy** (with optional signer weights). Any proposal (withdrawal / transfer) is recorded and only executed once approvals meet the wallet threshold.

This implementation uses **application-level approvals** (tracked in Postgres) and only broadcasts a Stellar transaction once fully authorized. Execution is protected with an **atomic DB lock** to prevent double-sends under concurrent approvals.

## Data Model (Postgres)
- `collective_wallets`: team wallet metadata + threshold + Stellar address (+ optional encrypted secret key).
- `wallet_signers`: membership list (user ↔ wallet) with signing `weight`.
- `multisig_proposals`: pending transfers (destination, amount, memo, status, expiration, execution metadata).
- `proposal_signatures`: per-user approval records (unique per proposal+signer).

## API Endpoints

### Create wallet
`POST /api/routes-d/teams/multi-sig`

Body:
```json
{
  "name": "Acme Agency",
  "threshold": 2,
  "stellarSecretKey": "S...",
  "signers": [
    { "userId": "userA", "weight": 1 },
    { "userId": "userB", "weight": 1 },
    { "userId": "userC", "weight": 1 }
  ]
}
```

Notes:
- `stellarSecretKey` is encrypted at rest (see `ENCRYPTION_KEY` below) and never returned by the API.
- `threshold` is compared against the **sum of signer weights**.

### Read wallets / proposals
`GET /api/routes-d/teams/multi-sig`

Query options:
- No query params: list wallets for the authenticated user.
- `?walletId=...`: wallet details, signers, latest proposals and approval progress.
- `?proposalId=...`: proposal details and approval progress.

### Propose a transfer
`POST /api/routes-d/teams/multi-sig/propose`

Body:
```json
{ "walletId": "walletId", "destination": "G...", "amount": 100, "memo": "Optional" }
```

Behavior:
- Requires proposer to be a wallet signer.
- Creates a `multisig_proposals` row with `expiresAt = now + 48h`.

### Approve a proposal (and execute when threshold met)
`POST /api/routes-d/teams/multi-sig/approve`

Body:
```json
{ "proposalId": "proposalId" }
```

Behavior:
- Requires caller to be a wallet signer.
- Creates a `proposal_signatures` row (idempotent if the user already approved).
- Computes approval progress as **sum(signer weights)** for recorded signatures.
- When threshold is met, claims an execution lock (`executionStartedAt`) and broadcasts the Stellar USDC payment, then marks proposal `executed`.

## Expiration
- Proposals expire after **48 hours** (and cannot be executed once expired).
- Expiration is applied opportunistically during `GET` (wallet/proposal fetch) and `approve`.

## Environment Variables
- `ENCRYPTION_KEY`: used to encrypt/decrypt stored wallet secret keys.
- `STELLAR_SECRET_KEY` (optional fallback): used only if it matches the wallet’s `stellarAddress` and the wallet does not have `encryptedSecretKey`.

## Testing Checklist (2-of-3)
1. Create a wallet with signers A/B/C and `threshold=2`.
2. A proposes a `$100` transfer → proposal is `pending`.
3. B approves → progress becomes `1 of 2 approved`, still `pending`.
4. C approves → execution triggers immediately, proposal becomes `executed` with `stellarTxHash`.
5. D (not a signer) attempts to approve → API returns `403 Forbidden`.

