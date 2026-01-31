/**
 * Virtual Account Provider Interface
 *
 * This interface defines the contract that all virtual account providers must implement.
 * Supports: Korapay, Monnify, Paystack
 */

export interface VirtualAccountCreateRequest {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  phoneNumber?: string;
}

export interface VirtualAccountDetails {
  accountNumber: string;
  accountName: string;
  bankName: string;
  provider: string;
  providerRef: string; // Provider's internal reference/ID
}

export interface DepositWebhookPayload {
  accountNumber: string;
  amount: number; // NGN amount
  reference: string; // Unique transaction reference
  sessionId?: string;
  senderName?: string;
  narration?: string;
  paymentDate: string;
  currency: string;
}

export interface WebhookVerificationResult {
  isValid: boolean;
  payload?: DepositWebhookPayload;
  error?: string;
}

/**
 * Base interface for all virtual account providers
 */
export interface IVirtualAccountProvider {
  /**
   * Provider name identifier
   */
  readonly name: "Korapay" | "Monnify" | "Paystack";

  /**
   * Create a new dedicated virtual account
   */
  createAccount(
    request: VirtualAccountCreateRequest,
  ): Promise<VirtualAccountDetails>;

  /**
   * Fetch existing account details (optional - some providers don't support this)
   */
  getAccount?(providerRef: string): Promise<VirtualAccountDetails>;

  /**
   * Verify webhook signature and parse payload
   */
  verifyWebhook(
    signature: string,
    payload: string,
    headers: Record<string, string>,
  ): Promise<WebhookVerificationResult>;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  name: string;
  apiKey: string;
  secretKey?: string;
  publicKey?: string;
  contractCode?: string; // For Monnify
  webhookSecret: string;
  baseUrl?: string;
}

/**
 * Provider error response
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public provider: string,
    public statusCode?: number,
    public rawError?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Rate limit error
 */
export class RateLimitError extends ProviderError {
  constructor(provider: string, retryAfter?: number) {
    super(`Rate limit exceeded for ${provider}`, provider, 429);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
  retryAfter?: number;
}

/**
 * Account already exists error
 */
export class AccountExistsError extends ProviderError {
  constructor(provider: string, accountNumber: string) {
    super(`Account already exists: ${accountNumber}`, provider, 409);
    this.name = "AccountExistsError";
    this.accountNumber = accountNumber;
  }
  accountNumber: string;
}
