#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env, String};

#[contract]
pub struct TrustlineHandler;

#[contractimpl]
impl TrustlineHandler {
    /// Simulates the 'change_trust' operation for a specific asset.
    /// This ensures the user's wallet is ready to receive payments.
    pub fn ensure_trustline(
        env: Env,
        user: Address,
        asset_code: String,
        _asset_issuer: Address,
    ) -> bool {
        user.require_auth();

        // 1. Check if trustline already exists (Idempotency)
        // let has_trust = env.storage().instance().get(&(user, asset_code)).unwrap_or(false);
        // if has_trust { return true; }

        // 2. Check minimal reserve (Mock)
        // In reality: Check if XLM balance > 0.5
        // if get_balance(user) < 0.5 { panic!("Insufficient reserve for trustline"); }

        // 3. Execute Change Trust (Simulated)
        // env.storage().instance().set(&(user, asset_code), &true);

        env.events().publish(
            (String::from_str(&env, "trustline_configured"), user),
            asset_code,
        );

        true
    }

    /// Helper to automate the setup specifically for the platform's USDC.
    pub fn setup_usdc_trustline(env: Env, user: Address) {
        let usdc_code = String::from_str(&env, "USDC");
        // Mock issuer address for simulation
        let usdc_issuer = user.clone();

        Self::ensure_trustline(env, user, usdc_code, usdc_issuer);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env, String};

    #[test]
    fn configures_a_usdc_trustline() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, TrustlineHandler);
        let client = TrustlineHandlerClient::new(&env, &id);
        let user = Address::generate(&env);

        assert!(client.ensure_trustline(&user, &String::from_str(&env, "USDC"), &user));
        client.setup_usdc_trustline(&user);
    }
}
