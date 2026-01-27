/**
 * Nigerian Bank Account Verification Service
 * Uses Paystack Resolve Account API to verify Nigerian bank accounts
 */

export interface BankVerificationResult {
    valid: boolean;
    accountName?: string;
    accountNumber?: string;
    error?: string;
  }
  
  interface PaystackResolveResponse {
    status: boolean;
    message: string;
    data?: {
      account_number: string;
      account_name: string;
      bank_id: number;
    };
  }
  
  /**
   * Verify a Nigerian bank account using Paystack
   * @param accountNumber - 10-digit Nigerian bank account number
   * @param bankCode - Nigerian bank code (e.g., "058" for GTBank)
   * @returns Verification result with account name if valid
   */
  export async function verifyNigerianBankAccount(
    accountNumber: string,
    bankCode: string
  ): Promise<BankVerificationResult> {
    try {
      // Validate input
      if (!accountNumber || !bankCode) {
        return {
          valid: false,
          error: 'Account number and bank code are required',
        };
      }
  
      // Validate account number format 
      if (!/^\d{10}$/.test(accountNumber)) {
        return {
          valid: false,
          error: 'Account number must be exactly 10 digits',
        };
      }
  
      // Check for Paystack secret key
      const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
      if (!paystackSecretKey) {
        console.error('PAYSTACK_SECRET_KEY not configured');
        return {
          valid: false,
          error: 'Bank verification service not configured',
        };
      }
  
      // Call Paystack Resolve Account API
      const response = await fetch(
        `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${paystackSecretKey}`,
            'Content-Type': 'application/json',
          },
        }
      );
  
      const data: PaystackResolveResponse = await response.json();
  
      // Handle API errors
      if (!response.ok || !data.status) {
        console.error('Paystack API error:', data.message);
        if (response.status === 422 || data.message.includes('Could not resolve')) {
          return {
            valid: false,
            error: 'Invalid account number or bank code',
          };
        }
  
        return {
          valid: false,
          error: 'Unable to verify account. Please try again.',
        };
      }
      if (data.data) {
        return {
          valid: true,
          accountName: data.data.account_name,
          accountNumber: data.data.account_number,
        };
      }
  
      return {
        valid: false,
        error: 'Unable to retrieve account information',
      };
    } catch (error) {
      console.error('Bank verification error:', error);
      if (error instanceof TypeError && error.message.includes('fetch')) {
        return {
          valid: false,
          error: 'Network error. Please check your connection and try again.',
        };
      }
      return {
        valid: false,
        error: 'An unexpected error occurred during verification',
      };
    }
  }
  
  export const NIGERIAN_BANKS = [
    { code: '044', name: 'Access Bank' },
    { code: '063', name: 'Access Bank (Diamond)' },
    { code: '050', name: 'Ecobank Nigeria' },
    { code: '070', name: 'Fidelity Bank' },
    { code: '011', name: 'First Bank of Nigeria' },
    { code: '214', name: 'First City Monument Bank' },
    { code: '058', name: 'Guaranty Trust Bank' },
    { code: '030', name: 'Heritage Bank' },
    { code: '301', name: 'Jaiz Bank' },
    { code: '082', name: 'Keystone Bank' },
    { code: '526', name: 'Parallex Bank' },
    { code: '076', name: 'Polaris Bank' },
    { code: '101', name: 'Providus Bank' },
    { code: '221', name: 'Stanbic IBTC Bank' },
    { code: '068', name: 'Standard Chartered Bank' },
    { code: '232', name: 'Sterling Bank' },
    { code: '100', name: 'Suntrust Bank' },
    { code: '032', name: 'Union Bank of Nigeria' },
    { code: '033', name: 'United Bank For Africa' },
    { code: '215', name: 'Unity Bank' },
    { code: '035', name: 'Wema Bank' },
    { code: '057', name: 'Zenith Bank' },
  ];