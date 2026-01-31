/**
 * Monnify Virtual Account Provider
 *
 * Documentation: https://docs.monnify.com/docs/reserved-accounts
 */

import crypto from "crypto";
import {
  IVirtualAccountProvider,
  VirtualAccountCreateRequest,
  VirtualAccountDetails,
  WebhookVerificationResult,
  ProviderError,
  AccountExistsError,
} from "../provider-interface";

export class MonnifyProvider implements IVirtualAccountProvider {
  readonly name = "Monnify" as const;
  private apiKey: string;
  private secretKey: string;
  private contractCode: string;
  private webhookSecret: string;
  private baseUrl: string;
  private accessToken?: string;
  private tokenExpiry?: number;

  constructor(config: {
    apiKey: string;
    secretKey: string;
    contractCode: string;
    webhookSecret: string;
    baseUrl?: string;
  }) {
    this.apiKey = config.apiKey;
    this.secretKey = config.secretKey;
    this.contractCode = config.contractCode;
    this.webhookSecret = config.webhookSecret;
    this.baseUrl = config.baseUrl || "https://api.monnify.com/api/v1";
  }

  /**
   * Get access token for Monnify API
   * Monnify uses Basic Auth to get bearer token
   */
  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    try {
      const credentials = Buffer.from(
        `${this.apiKey}:${this.secretKey}`,
      ).toString("base64");

      const response = await fetch(`${this.baseUrl}/auth/login`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/json",
        },
      });

      const data = await response.json();

      if (!response.ok) {
        throw new ProviderError(
          data.responseMessage || "Failed to authenticate",
          this.name,
          response.status,
          data,
        );
      }

      this.accessToken = data.responseBody.accessToken;
      // Token typically expires in 1 hour, cache for 50 minutes to be safe
      this.tokenExpiry = Date.now() + 50 * 60 * 1000;

      return this.accessToken || "";
    } catch (error) {
      throw new ProviderError(
        `Monnify authentication failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        this.name,
        undefined,
        error,
      );
    }
  }

  /**
   * Create a reserved account (virtual account)
   * API: POST /bank-transfer/reserved-accounts
   */
  async createAccount(
    request: VirtualAccountCreateRequest,
  ): Promise<VirtualAccountDetails> {
    try {
      const token = await this.getAccessToken();

      const response = await fetch(
        `${this.baseUrl}/bank-transfer/reserved-accounts`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            accountReference: request.userId,
            accountName: `${request.firstName} ${request.lastName}`,
            currencyCode: "NGN",
            contractCode: this.contractCode,
            customerEmail: request.email,
            customerName: `${request.firstName} ${request.lastName}`,
            getAllAvailableBanks: false, // Use default bank
          }),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        // Handle duplicate account
        if (
          data.responseCode === "99" &&
          data.responseMessage?.includes("already exists")
        ) {
          throw new AccountExistsError(
            this.name,
            data.responseBody?.accounts?.[0]?.accountNumber || "unknown",
          );
        }

        throw new ProviderError(
          data.responseMessage || "Failed to create reserved account",
          this.name,
          response.status,
          data,
        );
      }

      // Monnify returns multiple account numbers for different banks
      // We'll use the first one
      const account = data.responseBody.accounts[0];

      if (!account) {
        throw new ProviderError(
          "No account details in response",
          this.name,
          500,
          data,
        );
      }

      return {
        accountNumber: account.accountNumber,
        accountName: account.accountName,
        bankName: account.bankName,
        provider: this.name,
        providerRef: data.responseBody.accountReference,
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError(
        `Monnify API error: ${error instanceof Error ? error.message : "Unknown error"}`,
        this.name,
        undefined,
        error,
      );
    }
  }

  /**
   * Get reserved account details
   * API: GET /bank-transfer/reserved-accounts/{accountReference}
   */
  async getAccount(providerRef: string): Promise<VirtualAccountDetails> {
    try {
      const token = await this.getAccessToken();

      const response = await fetch(
        `${this.baseUrl}/bank-transfer/reserved-accounts/${providerRef}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new ProviderError(
          data.responseMessage || "Failed to fetch account",
          this.name,
          response.status,
          data,
        );
      }

      const account = data.responseBody.accounts[0];

      return {
        accountNumber: account.accountNumber,
        accountName: account.accountName,
        bankName: account.bankName,
        provider: this.name,
        providerRef: data.responseBody.accountReference,
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError(
        `Monnify API error: ${error instanceof Error ? error.message : "Unknown error"}`,
        this.name,
        undefined,
        error,
      );
    }
  }

  /**
   * Verify webhook signature and parse payload
   * Monnify uses HMAC SHA-512 signature
   */
  async verifyWebhook(
    signature: string,
    payload: string,
    headers: Record<string, string>,
  ): Promise<WebhookVerificationResult> {
    try {
      // Monnify sends signature in monnify-signature header
      const providedSignature = signature || headers["monnify-signature"];

      if (!providedSignature) {
        return {
          isValid: false,
          error: "Missing webhook signature",
        };
      }

      // Compute expected signature using HMAC SHA-512
      const expectedSignature = crypto
        .createHmac("sha512", this.webhookSecret)
        .update(payload)
        .digest("hex");

      // Compare signatures
      const isValid = crypto.timingSafeEqual(
        Buffer.from(providedSignature, "hex"),
        Buffer.from(expectedSignature, "hex"),
      );

      if (!isValid) {
        return {
          isValid: false,
          error: "Invalid webhook signature",
        };
      }

      // Parse payload
      const parsedPayload = JSON.parse(payload);

      // Monnify webhook structure
      // eventType: SUCCESSFUL_TRANSACTION
      if (parsedPayload.eventType !== "SUCCESSFUL_TRANSACTION") {
        return {
          isValid: false,
          error: `Unsupported event: ${parsedPayload.eventType}`,
        };
      }

      const depositData = parsedPayload.eventData;

      return {
        isValid: true,
        payload: {
          accountNumber: depositData.destinationAccountNumber,
          amount: parseFloat(depositData.amountPaid),
          reference: depositData.transactionReference,
          sessionId: depositData.sessionId,
          senderName: depositData.customerName,
          narration: depositData.paymentDescription,
          paymentDate: depositData.paidOn || new Date().toISOString(),
          currency: depositData.currency || "NGN",
        },
      };
    } catch (error) {
      return {
        isValid: false,
        error: `Webhook verification failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }
}
