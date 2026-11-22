# Claimable Balances Architecture

## Overview

Stellar Claimable Balances decouple payment initiation from recipient trustline readiness. This prevents payment friction for newly onboarded Nigerian freelancers whose accounts may not yet hold a USDC trustline or minimum XLM reserves.

---

## Two-Step Claim Flow

### The Problem with Single-Step Payments
A common anti-pattern is checking if a user has a USDC trustline *before* creating the claimable balance, and failing the transaction with `op_no_trust` if they do not. This defeats the purpose of claimable balances by forcing the recipient to have their account funded with XLM and established *before* they can even receive funds.

### The Two-Step Flow Architecture

LancePay specifies a two-step claimable balance lifecycle:

#### Step 1: Creation (Sender) — Implemented
1. **Account Existence Check**: Verify if the specified recipient's Stellar public key exists on the network (Horizon account lookup).
2. **Missing Account Scenario**: If the account does not exist (HTTP 404 from Horizon), inform the sender that the recipient must create and fund an account with XLM, or trigger an automated wallet funding flow.
3. **Creation without Trustline**: Build the claimable balance transaction using `Claimant.predicateUnconditional()`. This succeeds on-chain even if the recipient lacks a USDC trustline.
4. **Notifications**: Dispatch internal event notifications alerting the recipient of an incoming balance.

#### Step 2: Claiming (Recipient) — Planned
> **Note**: Automated API claiming endpoints are planned under `/api/stellar/claimable-balances`. They are not implemented in the legacy `/api/routes-d/` tree.

1. **Auto-Detection**: When the recipient navigates to their dashboard, LancePay detects outstanding claimable balances where their address is listed as a valid claimant.
2. **Claim Request (Planned)**: The recipient submits a claim via the planned route:
   ```http
   POST /api/stellar/claimable-balances/claim
   Content-Type: application/json

   {
     "balanceId": "00000000...",
     "claimantAddress": "G..."
   }
   ```
3. **Trustline Check upon Claiming**: If the recipient attempts to claim before adding a USDC trustline, Stellar Horizon returns `op_no_trust`.
4. **Standard Error Mapping**: The route intercepts `op_no_trust` using the shared error-handling constant defined in `lib/claimable-balances.ts`:
   ```ts
   import { OP_NO_TRUST_ERROR_MESSAGE, mapClaimableBalanceError } from '@/lib/claimable-balances'
   ```
   **Message returned to client**:
   > *"Recipient must add USDC trustline before claiming. Please add a USDC trustline to your account first."*
5. **Settlement**: Once the recipient creates the trustline (or LancePay sponsors it), the claim transaction submits successfully, transferring the reserved balance into their active wallet.

---

## Predicates and Expiry for Time-Locked Payouts

Stellar Claimable Balances support expressive boolean predicates via `Claimant` predicates. LancePay utilizes these for milestone escrows, conditional dispute resolutions, and expiring freelancer payouts:

### Supported Predicate Combinations

1. **Unconditional Claim**:
   ```ts
   // Recipient can claim at any time
   const unconditionalClaimant = new Claimant(
     recipientPublicKey,
     Claimant.predicateUnconditional()
   )
   ```

2. **Time-Locked Payout (Vesting / Delay)**:
   ```ts
   // Payout can only be claimed after a specific timestamp or milestone date
   const timeLockedClaimant = new Claimant(
     recipientPublicKey,
     Claimant.predicateNot(
       Claimant.predicateBeforeAbsoluteTime(milestoneReleaseEpochSeconds.toString())
     )
   )
   ```

3. **Time-Limited Payout with Sender Clawback / Expiry**:
   To prevent funds from remaining permanently locked if a recipient never registers or claims their balance, LancePay configures a dual-claimant structure with an expiration deadline:
   - **Recipient Claimant**: Can claim before the deadline:
     ```ts
     Claimant.predicateBeforeAbsoluteTime(expiryEpochSeconds.toString())
     ```
   - **Sender (Platform / Payer) Claimant**: Can reclaim (clawback) after the deadline has passed:
     ```ts
     Claimant.predicateNot(
       Claimant.predicateBeforeAbsoluteTime(expiryEpochSeconds.toString())
     )
     ```

### Lifecycle State Machine

```
              ┌─────────────────────────────┐
              │   Sender Creates Balance    │
              └──────────────┬──────────────┘
                             │
            ┌────────────────┴────────────────┐
            │                                 │
     Before Expiry                      After Expiry
            │                                 │
            ▼                                 ▼
   Recipient Claims                  Sender Reclaims
 (Requires USDC Trustline)          (Refunds Principal)
```

---

## Planned API Specifications

The upcoming `/api/stellar/claimable-balances` suite includes:

| Method | Endpoint | Status | Description |
|---|---|---|---|
| `POST` | `/api/stellar/claimable-balances/create` | Planned | Creates a claimable balance with optional time predicates |
| `POST` | `/api/stellar/claimable-balances/claim` | Planned | Submits a claim transaction with automatic `op_no_trust` interception |
| `GET` | `/api/stellar/claimable-balances` | Planned | Queries pending claimable balances for the authenticated user |

Shared error constants and mapping utilities are maintained in `lib/claimable-balances.ts` and covered by automated unit tests in `tests/claimable-balances.test.ts`.
