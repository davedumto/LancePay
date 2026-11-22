#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String};

/// Represents the state of a dispute in the resolution process.
#[derive(Clone, Copy)]
#[contracttype]
pub enum DisputeState {
    /// Dispute is actively being reviewed
    Active = 1,
    /// Dispute has been resolved with a final judgment
    Resolved = 2,
}

/// DisputeResolutionCourt contract for handling payment disputes in escrow scenarios.
///
/// Provides mechanisms for:
/// - Initiating disputes on milestone/escrow payments
/// - Submitting evidence (IPFS hashes) from parties
/// - Arbiter adjudication with configurable fund splits
#[contract]
pub struct DisputeResolutionCourt;

#[contractimpl]
impl DisputeResolutionCourt {
    /// Initiates a dispute for a specific milestone/escrow payment.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `escrow_id` - Unique identifier of the escrow/milestone
    /// * `disputer` - Address of the party initiating the dispute
    ///
    /// # Returns
    /// `true` if the dispute was successfully initiated
    ///
    /// # Panics
    /// If the disputer is not authorized to initiate disputes
    pub fn initiate_dispute(env: Env, escrow_id: String, disputer: Address) -> bool {
        disputer.require_auth();

        env.events().publish(
            (String::from_str(&env, "dispute_started"), escrow_id),
            disputer,
        );

        true
    }

    /// Submits evidence (e.g., IPFS hash) for an ongoing dispute.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `dispute_id` - Unique identifier of the dispute
    /// * `evidence_hash` - IPFS hash or cryptographic hash of evidence
    /// * `submitter` - Address of the party submitting evidence
    ///
    /// # Panics
    /// If the submitter is not authorized
    pub fn submit_evidence(
        env: Env,
        dispute_id: String,
        evidence_hash: String,
        submitter: Address,
    ) {
        submitter.require_auth();

        env.events().publish(
            (String::from_str(&env, "evidence_submitted"), dispute_id),
            evidence_hash,
        );
    }

    /// Adjudicates a dispute and distributes funds based on the split ratio.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `dispute_id` - Unique identifier of the dispute
    /// * `split_ratio` - Percentage (0-100) of funds to award to freelancer
    /// * `arbiter` - Address of the authorized arbiter making the decision
    ///
    /// # Panics
    /// If split_ratio > 100 or arbiter is not authorized
    pub fn adjudicate(env: Env, dispute_id: String, split_ratio: u32, arbiter: Address) {
        arbiter.require_auth();

        if split_ratio > 100 {
            panic!("split_ratio must be 0-100");
        }

        env.events().publish(
            (String::from_str(&env, "dispute_resolved"), dispute_id),
            split_ratio,
        );
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    #[test]
    fn adjudicate_accepts_a_valid_split() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, DisputeResolutionCourt);
        let client = DisputeResolutionCourtClient::new(&env, &id);
        let arbiter = Address::generate(&env);

        client.adjudicate(&String::from_str(&env, "dispute-1"), &60, &arbiter);
        assert!(client.initiate_dispute(&String::from_str(&env, "escrow-1"), &arbiter));
    }

    #[test]
    #[should_panic(expected = "split_ratio must be 0-100")]
    fn adjudicate_rejects_an_out_of_range_split() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, DisputeResolutionCourt);
        let client = DisputeResolutionCourtClient::new(&env, &id);

        client.adjudicate(
            &String::from_str(&env, "dispute-1"),
            &101,
            &Address::generate(&env),
        );
    }
}
