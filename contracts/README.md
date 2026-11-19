# Milestone Escrow Smart Contract

Soroban-based escrow contract for milestone-based payments on Stellar.

## Features

- **Trustless Escrow**: Funds locked on-chain until milestone completion
- **Client Protection**: Only release funds when satisfied
- **Freelancer Security**: Guaranteed payment once approved
- **Arbiter Support**: Platform can intervene if needed
- **State Archival Protection**: Automatic instance TTL extensions on contract interactions

## Functions

- `init(client, freelancer, arbiter, token)` - One-time contract initialization; requires `client` authentication and guards against re-initialization.
- `fund_milestone(from, amount)` - Client deposits positive tokens into escrow, accumulating into `Amount` and transitioning status to `Funded`. Rejects zero/negative amounts and completed escrows.
- `release_funds(caller)` - Client or arbiter releases escrowed funds to freelancer; strictly requires status to be `Funded` (release on `Pending` or `Completed` is rejected).
- `status()` - Check milestone status (`Pending`, `Funded`, or `Completed`).
- `get_amount()` - Check current funded escrow amount.

## Milestone Status Transitions

| Current State | Action | Next State | Notes |
|---|---|---|---|
| Uninitialized | `init()` | `Pending` | One-time setup with client auth verification |
| `Pending` | `fund_milestone()` | `Funded` | Requires amount > 0; accumulates balance |
| `Funded` | `release_funds()` | `Completed` | Transfers tokens to freelancer |
| `Pending` | `release_funds()` | *Error* | Release disallowed before funding |
| `Completed` | *Any transition* | *Error* | Terminal state; no re-funding or re-release |

## State Archival & TTL Policy

The contract automatically extends its instance storage TTL during `init()`, `fund_milestone()`, and `release_funds()` calls using:
- **Threshold**: `120,960` ledgers (~7 days)
- **Extend To**: `518,400` ledgers (~30 days)

## Build

```bash
cd contracts
soroban contract build
```

## Deploy to Testnet

```bash
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/milestone_escrow.wasm \
  --network testnet
```

## Related Issue

Closes #89
