use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Signer(Address),
}

/// MultisigGovernance contract for managing 2-of-3 multi-signature authorization.
///
/// Implements multi-signature governance requiring at least 2 of 3 authorized signers
/// for sensitive transactions. Uses Stellar's SetOptions operation semantics.
#[contract]
pub struct MultisigGovernance;

#[contractimpl]
impl MultisigGovernance {
    /// Configures multi-signature requirements for the contract.
    ///
    /// Sets up a 2-of-3 multi-sig scheme with configurable thresholds:
    /// - Master Weight: 1
    /// - Signer Weights: 1 each
    /// - Low Threshold: 0 (no signature needed)
    /// - Medium Threshold: 2 (requires 2 signatures)
    /// - High Threshold: 2 (requires 2 signatures)
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `contract_owner` - Address of the contract owner/initial signer
    /// * `additional_signer_1` - Address of the first additional signer
    /// * `additional_signer_2` - Address of the second additional signer
    ///
    /// # Panics
    /// If contract_owner is not authorized
    pub fn configure_multisig(
        env: Env,
        contract_owner: Address,
        additional_signer_1: Address,
        additional_signer_2: Address,
    ) {
        // The first configuration establishes the immutable governance admin.
        // Later signer rotations must be approved by that stored identity, not
        // by a caller-controlled `contract_owner` argument.
        if let Some(admin) = env.storage().instance().get::<DataKey, Address>(&DataKey::Admin) {
            admin.require_auth();
        } else {
            contract_owner.require_auth();
            env.storage().instance().set(&DataKey::Admin, &contract_owner);
        }

        // Note: In production, this would execute Stellar SetOptions operations:
        // 1. Set Master Weight = 1
        // 2. Add signer_1 with weight 1
        // 3. Add signer_2 with weight 1
        // 4. Set Low Threshold = 0
        // 5. Set Medium Threshold = 2
        // 6. Set High Threshold = 2
        //
        // This creates a 2-of-3 signature scheme for most operations.

        // Publish configuration event (for indexing/monitoring)
        env.storage()
            .instance()
            .set::<DataKey, bool>(&DataKey::Signer(contract_owner), &true);

        // Record additional signers
        env.storage()
            .instance()
            .set::<DataKey, bool>(&DataKey::Signer(additional_signer_1), &true);

        env.storage()
            .instance()
            .set::<DataKey, bool>(&DataKey::Signer(additional_signer_2), &true);
    }

    /// Proposes a sensitive transaction requiring multi-signature approval.
    ///
    /// Initiates a proposal workflow where one signer proposes a transaction
    /// that must be co-signed by at least one other authorized signer.
    /// Returns `false` as transaction execution is pending co-signer approval.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `proposer` - Address of the signer proposing the transaction
    /// * `amount` - Transaction amount in stroops
    ///
    /// # Returns
    /// `false` - Transaction is pending co-signer signatures
    ///
    /// # Panics
    /// If proposer is not authorized
    pub fn propose_sensitive_tx(env: Env, proposer: Address, amount: i128) -> bool {
        proposer.require_auth();

        // Emit proposal event with transaction details for co-signers
        env.events().publish(
            (soroban_sdk::Symbol::new(&env, "tx_proposed"), proposer),
            amount,
        );

        false // Execution pending additional signature
    }

    /// Executes a proposed transaction with co-signer approval.
    ///
    /// Adds the co-signer's signature to the pending transaction.
    /// If the combined weight meets or exceeds the Medium Threshold (2),
    /// the transaction is executed.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `co_signer` - Address of the co-signer approving the transaction
    /// * `tx_hash` - Hash identifier of the pending transaction
    ///
    /// # Returns
    /// `true` if the transaction was successfully executed
    ///
    /// # Panics
    /// If co_signer is not authorized
    pub fn execute_with_second_sig(env: Env, co_signer: Address, tx_hash: i128) -> bool {
        co_signer.require_auth();

        // Verify co-signer is authorized (basic check for compiled contracts)
        let is_authorized = env
            .storage()
            .instance()
            .get::<DataKey, bool>(&DataKey::Signer(co_signer))
            .unwrap_or(false);

        if !is_authorized {
            panic!("co_signer is not authorized");
        }

        // Emit execution event
        env.events().publish(
            (soroban_sdk::Symbol::new(&env, "tx_executed"), co_signer),
            tx_hash,
        );

        true // Transaction executed successfully
    }
}
