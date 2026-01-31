/**
 * Validation utilities for virtual accounts
 */

import { z } from "zod";

/**
 * Validate Nigerian NUBAN (Nigerian Uniform Bank Account Number)
 * NUBAN is exactly 10 digits
 */
export function isValidNUBAN(accountNumber: string): boolean {
  return /^\d{10}$/.test(accountNumber);
}

/**
 * Validate amount (must be positive number)
 */
export function isValidAmount(amount: number): boolean {
  return (
    typeof amount === "number" &&
    amount > 0 &&
    !isNaN(amount) &&
    isFinite(amount)
  );
}

/**
 * Webhook payload validation schema
 */
export const WebhookPayloadSchema = z.object({
  accountNumber: z.string().regex(/^\d{10}$/, "Invalid NUBAN format"),
  amount: z.number().positive("Amount must be positive"),
  reference: z.string().min(1, "Reference is required"),
  sessionId: z.string().optional(),
  senderName: z.string().optional(),
  narration: z.string().optional(),
  paymentDate: z.string(),
  currency: z.string().default("NGN"),
});

/**
 * Account creation request validation schema
 */
export const AccountCreateRequestSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
  email: z.string().email("Invalid email"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  phoneNumber: z.string().optional(),
});

/**
 * Validate deposit amount against minimum threshold
 */
export function validateMinimumDeposit(
  ngnAmount: number,
  minimumNGN: number = 100,
): { valid: boolean; error?: string } {
  if (ngnAmount < minimumNGN) {
    return {
      valid: false,
      error: `Deposit amount ₦${ngnAmount} is below minimum threshold of ₦${minimumNGN}`,
    };
  }
  return { valid: true };
}

/**
 * Sanitize account name (remove special characters, limit length)
 */
export function sanitizeAccountName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9\s-]/g, "") // Remove special chars except spaces and hyphens
    .trim()
    .substring(0, 255); // Limit to 255 chars
}

/**
 * Validate provider name
 */
export function isValidProvider(
  provider: string,
): provider is "Korapay" | "Monnify" | "Paystack" {
  return ["Korapay", "Monnify", "Paystack"].includes(provider);
}
