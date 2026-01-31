/**
 * SEP-24 Hosted Deposit and Withdrawal
 * 
 * Implements the interactive deposit/withdrawal flow for Stellar anchors.
 * Handles withdrawal initiation, status polling, and payment submission.
 */

import { fetchStellarToml, type AnchorId, ANCHOR_CONFIGS } from './anchors';
import { USDC_ASSET, server, STELLAR_NETWORK, isValidStellarAddress } from '../stellar';
import { TransactionBuilder, Operation, Keypair, Memo, MemoType } from '@stellar/stellar-sdk';

export type Sep24TransactionStatus = 
  | 'incomplete'      // Not yet submitted by anchor 
  | 'pending_user_transfer_start'  // User needs to send funds
  | 'pending_user_transfer_complete'  // User has sent funds, waiting for confirmation
  | 'pending_anchor'  // Anchor is processing
  | 'pending_stellar' // Stellar transaction being submitted
  | 'pending_trust'   // User needs to accept trustline
  | 'pending_external' // External transfer pending
  | 'completed'       // Transaction completed
  | 'refunded'        // Transaction refunded
  | 'expired'         // Transaction expired
  | 'error';          // Transaction failed

export interface Sep24Info {
  withdraw: {
    [asset: string]: {
      enabled: boolean;
      minAmount?: number;
      maxAmount?: number;
      feeFixed?: number;
      feePercent?: number;
    };
  };
  deposit: {
    [asset: string]: {
      enabled: boolean;
      minAmount?: number;
      maxAmount?: number;
    };
  };
}

export interface Sep24WithdrawResponse {
  type: 'interactive_customer_info_needed';
  url: string;  // Interactive URL to embed in iframe
  id: string;   // Transaction ID
}

export interface Sep24Transaction {
  id: string;
  kind: 'deposit' | 'withdrawal';
  status: Sep24TransactionStatus;
  status_eta?: number;
  amount_in?: string;
  amount_out?: string;
  amount_fee?: string;
  started_at: string;
  completed_at?: string;
  stellar_transaction_id?: string;
  external_transaction_id?: string;
  message?: string;
  withdraw_anchor_account?: string;
  withdraw_memo?: string;
  withdraw_memo_type?: MemoType;
}

/**
 * Fetch anchor's SEP-24 info endpoint
 * This tells us what assets are supported and any limits/fees
 */
export async function getAnchorInfo(anchorId: AnchorId): Promise<Sep24Info> {
  const toml = await fetchStellarToml(anchorId);
  
  const response = await fetch(`${toml.transferServerSep24}/info`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    },
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get SEP-24 info: ${error}`);
  }
  
  return response.json();
}

/**
 * Initiate a SEP-24 withdrawal
 * 
 * @param anchorId The anchor to withdraw through
 * @param jwtToken The SEP-10 authentication token
 * @param asset The asset code to withdraw (e.g., 'USDC')
 * @param amount The amount to withdraw
 * @param account The user's Stellar account address
 * @returns Interactive URL and transaction ID
 */
export async function initiateWithdrawal(
  anchorId: AnchorId,
  jwtToken: string,
  asset: string,
  amount: string,
  account: string
): Promise<Sep24WithdrawResponse> {
  const toml = await fetchStellarToml(anchorId);
  const config = ANCHOR_CONFIGS[anchorId];
  
  // Prepare form data for the request
  const formData = new URLSearchParams();
  formData.append('asset_code', asset);
  formData.append('amount', amount);
  formData.append('account', account);
  
  // Add anchor-specific fields if needed
  if (anchorId === 'yellowcard') {
    formData.append('type', 'bank_account');
  } else if (anchorId === 'moneygram') {
    formData.append('type', 'cash');
  }
  
  const response = await fetch(`${toml.transferServerSep24}/transactions/withdraw/interactive`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwtToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formData.toString(),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to initiate withdrawal: ${error}`);
  }
  
  const data = await response.json();
  
  if (!data.url || !data.id) {
    throw new Error('Invalid SEP-24 withdrawal response');
  }
  
  return {
    type: 'interactive_customer_info_needed',
    url: data.url,
    id: data.id,
  };
}

/**
 * Get the status of a SEP-24 transaction
 * 
 * @param anchorId The anchor handling the transaction
 * @param jwtToken The SEP-10 authentication token
 * @param transactionId The transaction ID from initiateWithdrawal
 * @returns Current transaction status and details
 */
export async function getTransaction(
  anchorId: AnchorId,
  jwtToken: string,
  transactionId: string
): Promise<Sep24Transaction> {
  const toml = await fetchStellarToml(anchorId);
  
  const response = await fetch(
    `${toml.transferServerSep24}/transaction?id=${encodeURIComponent(transactionId)}`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Accept': 'application/json',
      },
    }
  );
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get transaction: ${error}`);
  }
  
  const data = await response.json();
  
  if (!data.transaction) {
    throw new Error('Invalid transaction response');
  }
  
  return data.transaction as Sep24Transaction;
}

/**
 * Get all transactions for a user
 * 
 * @param anchorId The anchor to query
 * @param jwtToken The SEP-10 authentication token
 * @param kind Optional filter by 'deposit' or 'withdrawal'
 * @returns List of transactions
 */
export async function getTransactions(
  anchorId: AnchorId,
  jwtToken: string,
  kind?: 'deposit' | 'withdrawal'
): Promise<Sep24Transaction[]> {
  const toml = await fetchStellarToml(anchorId);
  
  const params = new URLSearchParams();
  if (kind) {
    params.append('kind', kind);
  }
  
  const response = await fetch(
    `${toml.transferServerSep24}/transactions?${params.toString()}`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Accept': 'application/json',
      },
    }
  );
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get transactions: ${error}`);
  }
  
  const data = await response.json();
  
  return (data.transactions || []) as Sep24Transaction[];
}

/**
 * Poll transaction status until it reaches a terminal state or timeout
 * 
 * @param anchorId The anchor handling the transaction
 * @param jwtToken The SEP-10 authentication token
 * @param transactionId The transaction ID
 * @param onStatusChange Optional callback for status changes
 * @param maxWaitMs Maximum time to wait (default 5 minutes)
 * @param pollIntervalMs Polling interval (default 5 seconds)
 * @returns Final transaction state
 */
export async function pollTransactionStatus(
  anchorId: AnchorId,
  jwtToken: string,
  transactionId: string,
  onStatusChange?: (status: Sep24TransactionStatus) => void,
  maxWaitMs = 5 * 60 * 1000,
  pollIntervalMs = 5000
): Promise<Sep24Transaction> {
  const terminalStatuses: Sep24TransactionStatus[] = [
    'completed',
    'refunded', 
    'expired',
    'error',
  ];
  
  const startTime = Date.now();
  let lastStatus: Sep24TransactionStatus | null = null;
  
  while (Date.now() - startTime < maxWaitMs) {
    const transaction = await getTransaction(anchorId, jwtToken, transactionId);
    
    if (lastStatus !== transaction.status) {
      lastStatus = transaction.status;
      onStatusChange?.(transaction.status);
    }
    
    if (terminalStatuses.includes(transaction.status)) {
      return transaction;
    }
    
    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  
  throw new Error('Transaction status polling timeout');
}

/**
 * Build a Stellar payment transaction to send funds to the anchor
 * This is called after the user completes the interactive flow
 * 
 * @param senderPublicKey The user's Stellar public key
 * @param anchorAddress The anchor's Stellar address (from transaction details)
 * @param amount The amount to send
 * @param memo Optional memo for the transaction
 * @param memoType Type of memo (text, id, hash)
 * @returns Unsigned transaction XDR
 */
export async function buildPaymentToAnchor(
  senderPublicKey: string,
  anchorAddress: string,
  amount: string,
  memo?: string,
  memoType?: MemoType
): Promise<string> {
  if (!isValidStellarAddress(anchorAddress)) {
    throw new Error('Invalid anchor address');
  }
  
  const account = await server.loadAccount(senderPublicKey);
  
  const builder = new TransactionBuilder(account, {
    fee: (await server.fetchBaseFee()).toString(),
    networkPassphrase: STELLAR_NETWORK,
  })
    .addOperation(
      Operation.payment({
        destination: anchorAddress,
        asset: USDC_ASSET,
        amount,
      })
    )
    .setTimeout(180); // 3 minute timeout
  
  // Add memo if provided
  if (memo && memoType) {
    switch (memoType) {
      case 'text':
        builder.addMemo(Memo.text(memo));
        break;
      case 'id':
        builder.addMemo(Memo.id(memo));
        break;
      case 'hash':
        builder.addMemo(Memo.hash(memo));
        break;
    }
  }
  
  const transaction = builder.build();
  return transaction.toXDR();
}

/**
 * Sign and submit a payment transaction to the Stellar network
 * This is used on the server-side when we have access to the secret key
 * 
 * @param transactionXdr The unsigned transaction XDR
 * @param signerSecretKey The secret key to sign with
 * @returns The submitted transaction hash
 */
export async function signAndSubmitPayment(
  transactionXdr: string,
  signerSecretKey: string
): Promise<string> {
  const { Transaction } = await import('@stellar/stellar-sdk');
  
  const transaction = new Transaction(transactionXdr, STELLAR_NETWORK);
  const keypair = Keypair.fromSecret(signerSecretKey);
  
  transaction.sign(keypair);
  
  const result = await server.submitTransaction(transaction);
  return result.hash;
}

/**
 * Check if a transaction status indicates the user needs to send funds
 */
export function needsPayment(status: Sep24TransactionStatus): boolean {
  return status === 'pending_user_transfer_start';
}

/**
 * Check if a transaction is in a terminal (completed) state
 */
export function isTerminalStatus(status: Sep24TransactionStatus): boolean {
  return ['completed', 'refunded', 'expired', 'error'].includes(status);
}

/**
 * Get a human-readable status message
 */
export function getStatusMessage(status: Sep24TransactionStatus): string {
  const messages: Record<Sep24TransactionStatus, string> = {
    incomplete: 'Please complete the required information',
    pending_user_transfer_start: 'Ready to send funds to anchor',
    pending_user_transfer_complete: 'Funds sent, waiting for confirmation',
    pending_anchor: 'Anchor is processing your withdrawal',
    pending_stellar: 'Submitting to Stellar network',
    pending_trust: 'Please accept the trustline',
    pending_external: 'External transfer in progress',
    completed: 'Withdrawal completed successfully',
    refunded: 'Transaction was refunded',
    expired: 'Transaction expired',
    error: 'An error occurred',
  };
  
  return messages[status] || 'Unknown status';
}
