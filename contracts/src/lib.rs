#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env};

pub mod auth;
pub mod monitor;
pub mod path_payment;
pub mod gasless;
pub mod upgrade_utils;
pub mod dispute_resolution;
pub mod trustline;
pub mod rebalancer;
pub mod multisig_governance;










#[derive(Clone, Copy)]
#[contracttype]
pub enum Status {
    Pending = 0,
    Funded = 1,
    Completed = 2,
}

#[contracttype]
pub enum DataKey {
    Client,
    Freelancer,
    Arbiter,
    Amount,
    Status,
    TokenAddress,
}

#[contract]
pub struct MilestoneEscrow;

#[contractimpl]
impl MilestoneEscrow {
    pub fn init(
        env: Env,
        client: Address,
        freelancer: Address,
        arbiter: Address,
        token: Address,
    ) {
        env.storage().instance().set(&DataKey::Client, &client);
        env.storage().instance().set(&DataKey::Freelancer, &freelancer);
        env.storage().instance().set(&DataKey::Arbiter, &arbiter);
        env.storage().instance().set(&DataKey::TokenAddress, &token);
        env.storage().instance().set(&DataKey::Amount, &0i128);
        env.storage().instance().set(&DataKey::Status, &Status::Pending);
    }

    pub fn fund_milestone(env: Env, from: Address, amount: i128) {
        from.require_auth();

        let client: Address = env.storage().instance().get(&DataKey::Client).unwrap();
        if from != client {
            panic!("Only client can fund");
        }

        let token_address: Address = env.storage().instance().get(&DataKey::TokenAddress).unwrap();
        let token_client = token::Client::new(&env, &token_address);

        token_client.transfer(&from, &env.current_contract_address(), &amount);

        env.storage().instance().set(&DataKey::Amount, &amount);
        env.storage().instance().set(&DataKey::Status, &Status::Funded);
    }

    pub fn release_funds(env: Env, caller: Address) {
        caller.require_auth();

        let client: Address = env.storage().instance().get(&DataKey::Client).unwrap();
        let arbiter: Address = env.storage().instance().get(&DataKey::Arbiter).unwrap();

        if caller != client && caller != arbiter {
            panic!("Only client or arbiter can release funds");
        }

        let status: Status = env.storage().instance().get(&DataKey::Status).unwrap();
        if matches!(status, Status::Completed) {
            panic!("Funds already released");
        }

        let freelancer: Address = env.storage().instance().get(&DataKey::Freelancer).unwrap();
        let amount: i128 = env.storage().instance().get(&DataKey::Amount).unwrap();
        let token_address: Address = env.storage().instance().get(&DataKey::TokenAddress).unwrap();

        let token_client = token::Client::new(&env, &token_address);
        token_client.transfer(&env.current_contract_address(), &freelancer, &amount);

        env.storage().instance().set(&DataKey::Status, &Status::Completed);
        env.storage().instance().set(&DataKey::Amount, &0i128);
    }

    pub fn status(env: Env) -> Status {
        env.storage()
            .instance()
            .get(&DataKey::Status)
            .unwrap_or(Status::Pending)
    }

    pub fn get_amount(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::Amount).unwrap_or(0)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    #[test]
    fn test_init() {
        let env = Env::default();
        let contract_id = env.register_contract(None, MilestoneEscrow);
        let client = MilestoneEscrowClient::new(&env, &contract_id);

        let client_addr = Address::generate(&env);
        let freelancer_addr = Address::generate(&env);
        let arbiter_addr = Address::generate(&env);
        let token_addr = Address::generate(&env);

        client.init(&client_addr, &freelancer_addr, &arbiter_addr, &token_addr);

        assert_eq!(client.status(), Status::Pending);
    }
}
