#![no_std]
use soroban_sdk::contracttype;

/// Ledger counts used by contracts that maintain instance TTL.
pub const DAY_IN_LEDGERS: u32 = 17_280;
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
pub const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;

/// Escrow lifecycle status shared by the escrow contract and its clients.
/// Discriminants are persisted on-chain and must never change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[contracttype]
pub enum Status {
    Pending = 0,
    Funded = 1,
    Completed = 2,
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn ttl_constants_match_documented_windows() {
        assert_eq!(INSTANCE_LIFETIME_THRESHOLD, 120_960);
        assert_eq!(INSTANCE_BUMP_AMOUNT, 518_400);
    }

    #[test]
    fn status_discriminants_are_stable() {
        assert_eq!(Status::Pending as u32, 0);
        assert_eq!(Status::Funded as u32, 1);
        assert_eq!(Status::Completed as u32, 2);
    }
}
