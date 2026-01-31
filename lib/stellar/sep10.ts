/**
 * SEP-10 Stellar Web Authentication
 * 
 * Implements challenge-response authentication for Stellar anchors.
 * Used to prove ownership of a Stellar account before SEP-24 operations.
 */

import { Transaction, Networks, Keypair } from '@stellar/stellar-sdk';
import { fetchStellarToml, type AnchorId } from './anchors';

export interface Sep10ChallengeResponse {
  transaction: string; // XDR encoded transaction
  networkPassphrase: string;
}

export interface Sep10TokenResponse {
  token: string;
  expiresAt: Date;
}

/**
 * Get the network passphrase for the current environment
 */
export function getNetworkPassphrase(): string {
  return process.env.NEXT_PUBLIC_STELLAR_NETWORK === 'mainnet'
    ? Networks.PUBLIC
    : Networks.TESTNET;
}

/**
 * Request an authentication challenge from an anchor
 * 
 * @param anchorId The anchor to authenticate with
 * @param clientPublicKey The user's Stellar public key
 * @param homeDomain Optional home domain for the wallet
 * @returns The challenge transaction XDR and network passphrase
 */
export async function getChallenge(
  anchorId: AnchorId,
  clientPublicKey: string,
  homeDomain?: string
): Promise<Sep10ChallengeResponse> {
  const toml = await fetchStellarToml(anchorId);
  
  const params = new URLSearchParams({
    account: clientPublicKey,
  });
  
  if (homeDomain) {
    params.append('home_domain', homeDomain);
  }
  
  const response = await fetch(`${toml.webAuthEndpoint}?${params.toString()}`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    },
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get SEP-10 challenge: ${error}`);
  }
  
  const data = await response.json();
  
  if (!data.transaction) {
    throw new Error('Invalid SEP-10 challenge response: missing transaction');
  }
  
  return {
    transaction: data.transaction,
    networkPassphrase: data.network_passphrase || getNetworkPassphrase(),
  };
}

/**
 * Verify that a challenge transaction is valid
 * This should be called before signing to ensure the challenge is legitimate
 * 
 * @param challengeXdr The challenge transaction XDR
 * @param anchorId The anchor that issued the challenge
 * @param clientPublicKey The user's public key (expected in the transaction)
 */
export async function verifyChallenge(
  challengeXdr: string,
  anchorId: AnchorId,
  clientPublicKey: string
): Promise<boolean> {
  try {
    const toml = await fetchStellarToml(anchorId);
    const networkPassphrase = getNetworkPassphrase();
    
    const transaction = new Transaction(challengeXdr, networkPassphrase);
    
    // Verify the transaction is from the anchor's signing key
    const serverPublicKey = toml.signingKey;
    const signatures = transaction.signatures;
    
    // First signature should be from the anchor
    if (signatures.length === 0) {
      console.warn('Challenge has no signatures');
      return false;
    }
    
    // Verify source account matches server
    if (transaction.source !== serverPublicKey) {
      console.warn('Challenge source does not match server signing key');
      return false;
    }
    
    // Verify the transaction has the correct sequence number (0)
    if (transaction.sequence !== '0') {
      console.warn('Challenge sequence number is not 0');
      return false;
    }
    
    // Verify there's a manage_data operation with expected client key
    const operations = transaction.operations;
    const manageDataOp = operations.find(
      op => op.type === 'manageData' && op.source === clientPublicKey
    );
    
    if (!manageDataOp) {
      console.warn('Challenge missing manageData operation for client');
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('Error verifying challenge:', error);
    return false;
  }
}

/**
 * Sign a challenge transaction using a Stellar keypair
 * This is used on the server-side when we have access to the secret key
 * 
 * @param challengeXdr The challenge transaction XDR
 * @param signerSecretKey The secret key to sign with
 * @returns The signed transaction XDR
 */
export function signChallengeWithSecretKey(
  challengeXdr: string,
  signerSecretKey: string
): string {
  const networkPassphrase = getNetworkPassphrase();
  const transaction = new Transaction(challengeXdr, networkPassphrase);
  const keypair = Keypair.fromSecret(signerSecretKey);
  
  transaction.sign(keypair);
  
  return transaction.toXDR();
}

/**
 * Build a transaction that can be signed by an external wallet (Privy)
 * Returns data needed for client-side signing
 * 
 * @param challengeXdr The challenge transaction XDR from the anchor
 * @returns Object with transaction details for wallet signing
 */
export function prepareForWalletSigning(challengeXdr: string): {
  transactionXdr: string;
  networkPassphrase: string;
} {
  return {
    transactionXdr: challengeXdr,
    networkPassphrase: getNetworkPassphrase(),
  };
}

/**
 * Submit a signed challenge to the anchor and receive a JWT token
 * 
 * @param anchorId The anchor to authenticate with
 * @param signedTransactionXdr The signed challenge transaction XDR
 * @returns The authentication token and expiration
 */
export async function submitSignedChallenge(
  anchorId: AnchorId,
  signedTransactionXdr: string
): Promise<Sep10TokenResponse> {
  const toml = await fetchStellarToml(anchorId);
  
  const response = await fetch(toml.webAuthEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      transaction: signedTransactionXdr,
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to submit SEP-10 challenge: ${error}`);
  }
  
  const data = await response.json();
  
  if (!data.token) {
    throw new Error('Invalid SEP-10 token response: missing token');
  }
  
  // Parse JWT to get expiration (or use default 24 hours)
  let expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // Default 24 hours
  
  try {
    // JWT structure: header.payload.signature
    const parts = data.token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      if (payload.exp) {
        expiresAt = new Date(payload.exp * 1000);
      }
    }
  } catch (e) {
    console.warn('Could not parse JWT expiration, using default');
  }
  
  return {
    token: data.token,
    expiresAt,
  };
}

/**
 * Check if a token is expired or about to expire (within 5 minutes)
 */
export function isTokenExpired(expiresAt: Date): boolean {
  const buffer = 5 * 60 * 1000; // 5 minutes buffer
  return new Date(expiresAt.getTime() - buffer) <= new Date();
}

/**
 * Complete SEP-10 authentication flow (server-side)
 * This is used when we have access to the wallet secret key on the server
 * 
 * @param anchorId The anchor to authenticate with
 * @param walletPublicKey The user's wallet public key
 * @param walletSecretKey The user's wallet secret key
 * @returns The authentication token and expiration
 */
export async function authenticateWithAnchor(
  anchorId: AnchorId,
  walletPublicKey: string,
  walletSecretKey: string
): Promise<Sep10TokenResponse> {
  // Step 1: Get the challenge
  const challenge = await getChallenge(anchorId, walletPublicKey);
  
  // Step 2: Verify the challenge is legitimate
  const isValid = await verifyChallenge(challenge.transaction, anchorId, walletPublicKey);
  if (!isValid) {
    throw new Error('Invalid challenge from anchor');
  }
  
  // Step 3: Sign the challenge
  const signedXdr = signChallengeWithSecretKey(challenge.transaction, walletSecretKey);
  
  // Step 4: Submit and get token
  return submitSignedChallenge(anchorId, signedXdr);
}
