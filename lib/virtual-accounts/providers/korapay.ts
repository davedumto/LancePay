/**
 * Korapay Virtual Account Provider
 *
 * Documentation: https://developers.korapay.com/docs/virtual-bank-accounts
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

export class KorapayProvider implements IVirtualAccountProvider {
  readonly name = "Korapay" as const;
  private apiKey: string;
  private secretKey: string;
  private webhookSecret: string;
  private baseUrl: string;

  constructor(config: {
    apiKey: string;
    secretKey: string;
    webhookSecret: string;
    baseUrl?: string;
  }) {
    this.apiKey = config.apiKey;
    this.secretKey = config.secretKey;
    this.webhookSecret = config.webhookSecret;
    this.baseUrl = config.baseUrl || "https://api.korapay.com/merchant/api/v1";
  }

  /**
   * Create a dedicated virtual account
   * API: POST /virtual-bank-account
   */
  async createAccount(
    request: VirtualAccountCreateRequest,
  ): Promise<VirtualAccountDetails> {
    try {
      const response = await fetch(`${this.baseUrl}/virtual-bank-account`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.secretKey}`,
        },
        body: JSON.stringify({
          account_name: `${request.firstName} ${request.lastName}`,
          account_reference: request.userId, // Map user ID to Korapay reference
          bank_code: "DEFAULT", // Korapay assigns the bank automatically
          customer: {
            name: `${request.firstName} ${request.lastName}`,
            email: request.email,
          },
          permanent: true, // Create permanent account
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        // Handle duplicate account error
        if (
          response.status === 400 &&
          data.message?.includes("already exists")
        ) {
          throw new AccountExistsError(
            this.name,
            data.data?.account_number || "unknown",
          );
        }

        throw new ProviderError(
          data.message || "Failed to create virtual account",
          this.name,
          response.status,
          data,
        );
      }

      // Korapay response structure
      if (!data.status || data.data?.account_number === undefined) {
        throw new ProviderError(
          "Invalid response from Korapay",
          this.name,
          500,
          data,
        );
      }

      return {
        accountNumber: data.data.account_number,
        accountName: data.data.account_name,
        bankName: data.data.bank_name || "Korapay Virtual Bank",
        provider: this.name,
        providerRef: data.data.account_reference || request.userId,
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError(
        `Korapay API error: ${error instanceof Error ? error.message : "Unknown error"}`,
        this.name,
        undefined,
        error,
      );
    }
  }

  /**
   * Fetch existing account details
   * API: GET /virtual-bank-account/{reference}
   */
  async getAccount(providerRef: string): Promise<VirtualAccountDetails> {
    try {
      const response = await fetch(
        `${this.baseUrl}/virtual-bank-account/${providerRef}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.secretKey}`,
          },
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new ProviderError(
          data.message || "Failed to fetch account",
          this.name,
          response.status,
          data,
        );
      }

      return {
        accountNumber: data.data.account_number,
        accountName: data.data.account_name,
        bankName: data.data.bank_name || "Korapay Virtual Bank",
        provider: this.name,
        providerRef: data.data.account_reference,
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }

      throw new ProviderError(
        `Korapay API error: ${error instanceof Error ? error.message : "Unknown error"}`,
        this.name,
        undefined,
        error,
      );
    }
  }

  /**
   * Verify webhook signature and parse payload
   * Korapay uses HMAC SHA-256 signature
   */
  async verifyWebhook(
    signature: string,
    payload: string,
    headers: Record<string, string>,
  ): Promise<WebhookVerificationResult> {
    try {
      // Korapay sends signature in x-korapay-signature header
      const providedSignature = signature || headers["x-korapay-signature"];

      if (!providedSignature) {
        return {
          isValid: false,
          error: "Missing webhook signature",
        };
      }

      // Compute expected signature
      const expectedSignature = crypto
        .createHmac("sha256", this.webhookSecret)
        .update(payload)
        .digest("hex");

      // Compare signatures (timing-safe)
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

      // Korapay webhook structure for virtual account deposit
      // Event: virtual_bank_account.credited
      if (parsedPayload.event !== "virtual_bank_account.credited") {
        return {
          isValid: false,
          error: `Unsupported event: ${parsedPayload.event}`,
        };
      }

      const depositData = parsedPayload.data;

      return {
        isValid: true,
        payload: {
          accountNumber: depositData.account_number,
          amount: parseFloat(depositData.amount),
          reference: depositData.reference,
          sessionId: depositData.session_id,
          senderName: depositData.sender_name,
          narration: depositData.narration,
          paymentDate: depositData.created_at || new Date().toISOString(),
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
