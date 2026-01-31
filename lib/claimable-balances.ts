import {
  Operation,
  Claimant,
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  Account
} from "@stellar/stellar-sdk";
import { server, USDC_ASSET, STELLAR_NETWORK } from "./stellar";

/**
 * Check if an account has a USDC trustline
 */
export async function hasUSDCTrustline(publicKey: string): Promise<boolean> {
  try {
    const account = await server.loadAccount(publicKey);
    return account.balances.some(
      (balance) =>
        balance.asset_type !== "native" &&
        balance.asset_code === USDC_ASSET.code &&
        balance.asset_issuer === USDC_ASSET.issuer
    );
  } catch (error) {
    return false;
  }
}

/**
 * Create a claimable balance for a recipient without trustline
 */
export async function createClaimableBalance(
  senderKeypair: Keypair,
  recipientPublicKey: string,
  amount: string
) {
  const senderAccount = await server.loadAccount(senderKeypair.publicKey());

  const claimant = new Claimant(
    recipientPublicKey,
    Claimant.predicateUnconditional()
  );

  const transaction = new TransactionBuilder(senderAccount, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_NETWORK,
  })
    .addOperation(
      Operation.createClaimableBalance({
        asset: USDC_ASSET,
        amount: amount,
        claimants: [claimant],
      })
    )
    .setTimeout(180)
    .build();

  transaction.sign(senderKeypair);
  return await server.submitTransaction(transaction);
}

/**
 * Fetch claimable balances for a user
 */
export async function getClaimableBalances(publicKey: string) {
  const response = await server
    .claimableBalances()
    .claimant(publicKey)
    .call();

  return response.records.filter(
    (cb: any) =>
      cb.asset.split(":")[0] === USDC_ASSET.code &&
      cb.asset.split(":")[1] === USDC_ASSET.issuer
  );
}

/**
 * Claim a claimable balance
 */
export async function claimBalance(
  recipientKeypair: Keypair,
  balanceId: string
) {
  const account = await server.loadAccount(recipientKeypair.publicKey());

  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_NETWORK,
  })
    .addOperation(
      Operation.claimClaimableBalance({
        balanceId: balanceId,
      })
    )
    .setTimeout(180)
    .build();

  transaction.sign(recipientKeypair);
  return await server.submitTransaction(transaction);
}

/**
 * Get total claimable USDC amount for a user
 */
export async function getTotalClaimableAmount(publicKey: string): Promise<string> {
  const balances = await getClaimableBalances(publicKey);
  const total = balances.reduce((sum: number, cb: any) => {
    return sum + parseFloat(cb.amount);
  }, 0);
  return total.toFixed(7);
}
