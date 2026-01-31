/**
 * Paystack Virtual Account Provider
 * 
 * Documentation: https://paystack.com/docs/payments/dedicated-virtual-accounts
 */

import crypto from 'crypto'
import {
  IVirtualAccountProvider,
  VirtualAccountCreateRequest,
  VirtualAccountDetails,
  WebhookVerificationResult,
  ProviderError,
  AccountExistsError,
} from '../provider-interface'

export class PaystackProvider implements IVirtualAccountProvider {
  readonly name = 'Paystack' as const
  private secretKey: string
  private webhookSecret: string
  private baseUrl: string

  constructor(config: {
    secretKey: string
    webhookSecret: string
    baseUrl?: string
  }) {
    this.secretKey = config.secretKey
    this.webhookSecret = config.webhookSecret
    this.baseUrl = config.baseUrl || 'https://api.paystack.co'
  }

  /**
   * Create a dedicated virtual account
   * Paystack requires creating a customer first, then assigning a DVA
   * API: POST /dedicated_account
   */
  async createAccount(
    request: VirtualAccountCreateRequest
  ): Promise<VirtualAccountDetails> {
    try {
      // Step 1: Create or get customer
      const customerId = await this.getOrCreateCustomer(request)

      // Step 2: Create dedicated virtual account
      const response = await fetch(`${this.baseUrl}/dedicated_account`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.secretKey}`,
        },
        body: JSON.stringify({
          customer: customerId,
          preferred_bank: 'wema-bank', // Paystack default
          // Note: Paystack may require business verification for some banks
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        // Handle account already exists
        if (data.message?.includes('already has a dedicated account')) {
          // Fetch existing account
          const existingAccount = await this.getExistingAccount(customerId)
          if (existingAccount) {
            throw new AccountExistsError(this.name, existingAccount.accountNumber)
          }
        }

        throw new ProviderError(
          data.message || 'Failed to create dedicated account',
          this.name,
          response.status,
          data
        )
      }

      if (!data.status || !data.data) {
        throw new ProviderError(
          'Invalid response from Paystack',
          this.name,
          500,
          data
        )
      }

      return {
        accountNumber: data.data.account_number,
        accountName: data.data.account_name,
        bankName: data.data.bank.name,
        provider: this.name,
        providerRef: data.data.id.toString(),
      }
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error
      }

      throw new ProviderError(
        `Paystack API error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        this.name,
        undefined,
        error
      )
    }
  }

  /**
   * Create or get customer by email
   */
  private async getOrCreateCustomer(request: VirtualAccountCreateRequest): Promise<string> {
    try {
      // Try to fetch existing customer first
      const fetchResponse = await fetch(
        `${this.baseUrl}/customer/${encodeURIComponent(request.email)}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.secretKey}`,
          },
        }
      )

      const fetchData = await fetchResponse.json()

      if (fetchResponse.ok && fetchData.status) {
        return fetchData.data.customer_code
      }

      // Customer doesn't exist, create new one
      const createResponse = await fetch(`${this.baseUrl}/customer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.secretKey}`,
        },
        body: JSON.stringify({
          email: request.email,
          first_name: request.firstName,
          last_name: request.lastName,
          phone: request.phoneNumber,
        }),
      })

      const createData = await createResponse.json()

      if (!createResponse.ok || !createData.status) {
        throw new ProviderError(
          createData.message || 'Failed to create customer',
          this.name,
          createResponse.status,
          createData
        )
      }

      return createData.data.customer_code
    } catch (error) {
      throw new ProviderError(
        `Customer creation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        this.name,
        undefined,
        error
      )
    }
  }

  /**
   * Get existing dedicated account for a customer
   */
  private async getExistingAccount(
    customerCode: string
  ): Promise<VirtualAccountDetails | null> {
    try {
      const response = await fetch(
        `${this.baseUrl}/dedicated_account?customer=${customerCode}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.secretKey}`,
          },
        }
      )

      const data = await response.json()

      if (!response.ok || !data.status || !data.data.length) {
        return null
      }

      const account = data.data[0]

      return {
        accountNumber: account.account_number,
        accountName: account.account_name,
        bankName: account.bank.name,
        provider: this.name,
        providerRef: account.id.toString(),
      }
    } catch {
      return null
    }
  }

  /**
   * Get dedicated account details by ID
   */
  async getAccount(providerRef: string): Promise<VirtualAccountDetails> {
    try {
      const response = await fetch(
        `${this.baseUrl}/dedicated_account/${providerRef}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.secretKey}`,
          },
        }
      )

      const data = await response.json()

      if (!response.ok || !data.status) {
        throw new ProviderError(
          data.message || 'Failed to fetch account',
          this.name,
          response.status,
          data
        )
      }

      return {
        accountNumber: data.data.account_number,
        accountName: data.data.account_name,
        bankName: data.data.bank.name,
        provider: this.name,
        providerRef: data.data.id.toString(),
      }
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error
      }

      throw new ProviderError(
        `Paystack API error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        this.name,
        undefined,
        error
      )
    }
  }

  /**
   * Verify webhook signature and parse payload
   * Paystack uses HMAC SHA-512 signature in x-paystack-signature header
   */
  async verifyWebhook(
    signature: string,
    payload: string,
    headers: Record<string, string>
  ): Promise<WebhookVerificationResult> {
    try {
      // Paystack sends signature in x-paystack-signature header
      const providedSignature = signature || headers['x-paystack-signature']

      if (!providedSignature) {
        return {
          isValid: false,
          error: 'Missing webhook signature',
        }
      }

      // Compute expected signature using HMAC SHA-512
      const expectedSignature = crypto
        .createHmac('sha512', this.webhookSecret)
        .update(payload)
        .digest('hex')

      // Compare signatures
      const isValid = crypto.timingSafeEqual(
        Buffer.from(providedSignature),
        Buffer.from(expectedSignature)
      )

      if (!isValid) {
        return {
          isValid: false,
          error: 'Invalid webhook signature',
        }
      }

      // Parse payload
      const parsedPayload = JSON.parse(payload)

      // Paystack webhook structure
      // Event: charge.success or dedicatedaccount.assign
      // For deposits, we listen to charge.success events on dedicated accounts
      if (parsedPayload.event !== 'charge.success') {
        return {
          isValid: false,
          error: `Unsupported event: ${parsedPayload.event}`,
        }
      }

      const depositData = parsedPayload.data

      // Verify it's a dedicated account transaction
      if (depositData.channel !== 'dedicated_nuban') {
        return {
          isValid: false,
          error: 'Not a dedicated account transaction',
        }
      }

      return {
        isValid: true,
        payload: {
          accountNumber: depositData.authorization?.receiver_bank_account_number || '',
          amount: depositData.amount / 100, // Paystack sends amount in kobo (NGN cents)
          reference: depositData.reference,
          sessionId: depositData.id?.toString(),
          senderName: depositData.customer?.email,
          narration: depositData.metadata?.custom_fields?.[0]?.value,
          paymentDate: depositData.paid_at || new Date().toISOString(),
          currency: depositData.currency || 'NGN',
        },
      }
    } catch (error) {
      return {
        isValid: false,
        error: `Webhook verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }
    }
  }
}