# Milestone Escrow Smart Contract — Operational & Lifecycle Guide

Soroban smart contract for milestone-based freelancer escrow payments on the Stellar network.

---

## 1. Overview & Capabilities

- **Trustless Escrow**: Funds are locked on-chain in Soroban contract storage until project milestones are completed and approved.
- **Client Protection**: Escrowed funds can only be released upon client or arbiter authorization.
- **Freelancer Security**: Funds cannot be unilaterally retracted by the client once funded; disputes trigger arbiter mediation.
- **Arbiter Governance**: Platform arbiter identity can intervene in frozen or disputed escrows.
- **State Archival Protection**: Automatic instance TTL extensions on contract interactions ensure contract instance data remains active and accessible.

---

## 2. Smart Contract Methods

| Function | Parameters | Description |
|---|---|---|
| `init` | `client: Address, freelancer: Address, arbiter: Address, token: Address` | One-time contract initialization. Requires `client` signature and sets status to `Pending`. Guards against duplicate invocation. |
| `fund_milestone` | `from: Address, amount: i128` | Deposits tokens from `client` into escrow. Accumulates balance and transitions state to `Funded`. Rejects zero, negative, or unauthorized deposits. |
| `release_funds` | `caller: Address` | Releases escrowed balance to `freelancer`. Only executable by `client` or `arbiter` when in `Funded` state. Sets status to `Completed`. |
| `status` | None | Returns current milestone status: `Pending (0)`, `Funded (1)`, or `Completed (2)`. |
| `get_amount` | None | Returns currently funded token amount locked in the contract. |

### Milestone State Transitions

```
    [ Uninitialized ]
            │
            │ init(client, freelancer, arbiter, token)
            ▼
       [ Pending ]  (amount = 0)
            │
            │ fund_milestone(client, amount > 0)
            ▼
       [ Funded ]   (amount > 0)
            │
            │ release_funds(client or arbiter)
            ▼
      [ Completed ] (amount = 0, terminal state)
```

---

## 3. Build, Pinning & Deployment Lifecycle

### 3.1 Building the WASM
Compile the contract into WebAssembly targeting `wasm32-unknown-unknown`:
```bash
cd contracts
stellar contract build
# Or: cargo build --target wasm32-unknown-unknown --release
```
Artifact output location:
```
target/wasm32-unknown-unknown/release/milestone_escrow.wasm
```

### 3.2 WASM Hash Pinning
To guarantee deterministic deployments and prevent supply-chain tampering, compute and pin the SHA256 bytecode hash before uploading:
```bash
# On macOS / Linux
shasum -a 256 target/wasm32-unknown-unknown/release/milestone_escrow.wasm
# Example output: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```
Store this pinned hash in release notes and continuous delivery manifests.

### 3.3 Installing & Deploying with `stellar-cli`
Install the bytecode on the target network to receive the on-chain WASM hash:
```bash
stellar contract install \
  --wasm target/wasm32-unknown-unknown/release/milestone_escrow.wasm \
  --source <deployer-identity> \
  --network testnet
```

Deploy a contract instance referencing the pinned WASM hash:
```bash
stellar contract deploy \
  --wasm-hash <PINNED_WASM_HASH> \
  --source <deployer-identity> \
  --network testnet
```
This outputs the deployed **Contract ID** (e.g. `CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`).

### 3.4 Initializing the Contract Instance
Call `init` with the client identity authorizing setup:
```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source <client-identity> \
  --network testnet \
  -- \
  init \
  --client <CLIENT_STELLAR_ADDRESS> \
  --freelancer <FREELANCER_STELLAR_ADDRESS> \
  --arbiter <ARBITER_STELLAR_ADDRESS> \
  --token <USDC_TOKEN_CONTRACT_ADDRESS>
```

---

## 4. End-to-End Testnet Smoke Run

A full end-to-end testnet smoke flow exercises the complete escrow cycle:

```bash
# 1. Query initial status (must be Pending)
stellar contract invoke --id <CONTRACT_ID> --network testnet -- status
# -> 0 (Pending)

# 2. Query initial escrow balance (must be 0)
stellar contract invoke --id <CONTRACT_ID> --network testnet -- get_amount
# -> 0

# 3. Client funds milestone (e.g. 100 USDC with 7 decimal precision = 1,000,000,000 stroops)
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source <client-identity> \
  --network testnet \
  -- \
  fund_milestone \
  --from <CLIENT_STELLAR_ADDRESS> \
  --amount 1000000000

# 4. Verify status transitioned to Funded
stellar contract invoke --id <CONTRACT_ID> --network testnet -- status
# -> 1 (Funded)

# 5. Client (or Arbiter) releases funds upon milestone approval
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source <client-identity> \
  --network testnet \
  -- \
  release_funds \
  --caller <CLIENT_STELLAR_ADDRESS>

# 6. Verify status transitioned to Completed
stellar contract invoke --id <CONTRACT_ID> --network testnet -- status
# -> 2 (Completed)
```

To run this automated cycle locally, execute the bundled test harness:
```bash
./contracts/smoke-test.sh
```

---

## 5. Network Configuration & Environment Parity

The application interacts with deployed contracts via environment variables configured per environment:

| Variable | Description | Testnet Example | Mainnet Example |
|---|---|---|---|
| `NEXT_PUBLIC_STELLAR_NETWORK` | Selected network name | `testnet` | `mainnet` |
| `NEXT_PUBLIC_STELLAR_HORIZON_URL` | Horizon REST API URL | `https://horizon-testnet.stellar.org` | `https://horizon.stellar.org` |
| `STELLAR_RPC_URL` | Soroban RPC endpoint | `https://soroban-testnet.stellar.org` | `https://soroban.stellar.org` |
| `NEXT_PUBLIC_ESCROW_CONTRACT_ID` | Client-facing Escrow Contract ID | `C...` (Testnet Contract) | `C...` (Audited Mainnet Contract) |
| `ESCROW_CONTRACT_ID` | Server-side Escrow Contract ID | `C...` | `C...` |
| `NEXT_PUBLIC_USDC_ISSUER` | Stellar USDC asset issuer | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` |

### Network Passphrases
- **Testnet**: `Test SDF Network ; September 2015`
- **Mainnet**: `Public Global Stellar Network ; September 2015`
- **Local Standalone**: `Standalone Network ; February 2017`

---

## 6. Upgrades, Governance & TTL Policy

### 6.1 Admin Key & Governance Ownership
The platform admin identity is held by a multi-signature governance account (`contracts/src/multisig_governance.rs`). Individual clients or freelancers cannot invoke administrative upgrades or contract modifications.

### 6.2 Contract Upgrade Procedure
Soroban Protocol 20+ contracts upgrade executable bytecode in-place using WASM hash replacement:
1. Build and verify the upgraded WASM artifact.
2. Upload and record the new bytecode hash:
   ```bash
   stellar contract install --wasm <NEW_WASM> --source <admin-identity> --network <network>
   ```
3. Execute the contract upgrade function signed by the governance multi-sig:
   ```bash
   stellar contract invoke \
     --id <CONTRACT_ID> \
     --source <multisig-admin> \
     -- \
     upgrade \
     --new_wasm_hash <NEW_WASM_HASH>
   ```
4. Verify protocol compatibility and run regression smoke checks against the upgraded instance.

### 6.3 State Archival & TTL Extension
Soroban instances expire if their Time-To-Live (TTL) is not maintained.
- **Threshold**: `120,960` ledgers (~7 days).
- **Bump Amount**: `518,400` ledgers (~30 days).

`MilestoneEscrow` automatically extends its instance storage TTL inside `init()`, `fund_milestone()`, and `release_funds()`. For dormant escrows, manual extension can be triggered by any account:
```bash
stellar contract extend \
  --id <CONTRACT_ID> \
  --durability instance \
  --ledgers-to-extend 518400 \
  --network testnet \
  --source <payer-identity>
```

If an instance becomes archived, it can be restored:
```bash
stellar contract restore \
  --id <CONTRACT_ID> \
  --durability instance \
  --network testnet \
  --source <payer-identity>
```
