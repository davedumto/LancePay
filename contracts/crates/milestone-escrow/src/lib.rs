#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env};

pub use lancepay_contract_shared::Status;
use lancepay_contract_shared::{INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD};

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
    pub fn init(env: Env, client: Address, freelancer: Address, arbiter: Address, token: Address) {
        if env.storage().instance().has(&DataKey::Client) {
            panic!("Already initialized");
        }
        client.require_auth();

        env.storage().instance().set(&DataKey::Client, &client);
        env.storage()
            .instance()
            .set(&DataKey::Freelancer, &freelancer);
        env.storage().instance().set(&DataKey::Arbiter, &arbiter);
        env.storage().instance().set(&DataKey::TokenAddress, &token);
        env.storage().instance().set(&DataKey::Amount, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::Status, &Status::Pending);

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }

    pub fn fund_milestone(env: Env, from: Address, amount: i128) {
        from.require_auth();

        if amount <= 0 {
            panic!("Amount must be greater than zero");
        }

        let status: Status = env
            .storage()
            .instance()
            .get(&DataKey::Status)
            .unwrap_or(Status::Pending);
        if matches!(status, Status::Completed) {
            panic!("Milestone already completed");
        }

        let client: Address = env.storage().instance().get(&DataKey::Client).unwrap();
        if from != client {
            panic!("Only client can fund");
        }

        let token_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::TokenAddress)
            .unwrap();
        let token_client = token::Client::new(&env, &token_address);

        token_client.transfer(&from, &env.current_contract_address(), &amount);

        let current_amount: i128 = env.storage().instance().get(&DataKey::Amount).unwrap_or(0);
        let new_amount = current_amount.checked_add(amount).expect("Amount overflow");

        env.storage().instance().set(&DataKey::Amount, &new_amount);
        env.storage()
            .instance()
            .set(&DataKey::Status, &Status::Funded);

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }

    pub fn release_funds(env: Env, caller: Address) {
        caller.require_auth();

        let client: Address = env.storage().instance().get(&DataKey::Client).unwrap();
        let arbiter: Address = env.storage().instance().get(&DataKey::Arbiter).unwrap();

        if caller != client && caller != arbiter {
            panic!("Only client or arbiter can release funds");
        }

        let status: Status = env.storage().instance().get(&DataKey::Status).unwrap();
        match status {
            Status::Pending => panic!("Escrow is still pending funding"),
            Status::Completed => panic!("Funds already released"),
            Status::Funded => {}
        }

        let freelancer: Address = env.storage().instance().get(&DataKey::Freelancer).unwrap();
        let amount: i128 = env.storage().instance().get(&DataKey::Amount).unwrap();
        let token_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::TokenAddress)
            .unwrap();

        let token_client = token::Client::new(&env, &token_address);
        token_client.transfer(&env.current_contract_address(), &freelancer, &amount);

        env.storage()
            .instance()
            .set(&DataKey::Status, &Status::Completed);
        env.storage().instance().set(&DataKey::Amount, &0i128);

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
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
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MilestoneEscrow);
        let client = MilestoneEscrowClient::new(&env, &contract_id);

        let client_addr = Address::generate(&env);
        let freelancer_addr = Address::generate(&env);
        let arbiter_addr = Address::generate(&env);
        let token_addr = Address::generate(&env);

        client.init(&client_addr, &freelancer_addr, &arbiter_addr, &token_addr);

        assert_eq!(client.status(), Status::Pending);
        assert_eq!(client.get_amount(), 0);
    }

    #[test]
    #[should_panic(expected = "Already initialized")]
    fn test_duplicate_init_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MilestoneEscrow);
        let client = MilestoneEscrowClient::new(&env, &contract_id);

        let client_addr = Address::generate(&env);
        let freelancer_addr = Address::generate(&env);
        let arbiter_addr = Address::generate(&env);
        let token_addr = Address::generate(&env);

        client.init(&client_addr, &freelancer_addr, &arbiter_addr, &token_addr);
        client.init(&client_addr, &freelancer_addr, &arbiter_addr, &token_addr);
    }

    #[test]
    #[should_panic(expected = "Escrow is still pending funding")]
    fn test_release_funds_before_funding_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MilestoneEscrow);
        let client = MilestoneEscrowClient::new(&env, &contract_id);

        let client_addr = Address::generate(&env);
        let freelancer_addr = Address::generate(&env);
        let arbiter_addr = Address::generate(&env);
        let token_addr = Address::generate(&env);

        client.init(&client_addr, &freelancer_addr, &arbiter_addr, &token_addr);
        client.release_funds(&client_addr);
    }

    #[test]
    #[should_panic(expected = "Amount must be greater than zero")]
    fn test_fund_zero_amount_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MilestoneEscrow);
        let client = MilestoneEscrowClient::new(&env, &contract_id);

        let client_addr = Address::generate(&env);
        let freelancer_addr = Address::generate(&env);
        let arbiter_addr = Address::generate(&env);
        let token_addr = Address::generate(&env);

        client.init(&client_addr, &freelancer_addr, &arbiter_addr, &token_addr);
        client.fund_milestone(&client_addr, &0i128);
    }

    #[test]
    #[should_panic(expected = "Only client can fund")]
    fn test_unauthorized_funder_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MilestoneEscrow);
        let client = MilestoneEscrowClient::new(&env, &contract_id);

        let client_addr = Address::generate(&env);
        let freelancer_addr = Address::generate(&env);
        let arbiter_addr = Address::generate(&env);
        let token_addr = Address::generate(&env);
        let stranger_addr = Address::generate(&env);

        client.init(&client_addr, &freelancer_addr, &arbiter_addr, &token_addr);
        client.fund_milestone(&stranger_addr, &500i128);
    }
}
