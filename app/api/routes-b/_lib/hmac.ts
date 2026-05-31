import crypto from "crypto";

/**
 * Generate a cryptographically secure webhook secret.
 *
 * Time Complexity: O(1) - Fixed 32 bytes
 * Space Complexity: O(1) - Returns 64-char hex string
 *
 * @returns 64-character hex string (32 bytes of random data)
 */
export function generateWebhookSecret() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Sign a webhook payload with HMAC-SHA256.
 *
 * Time Complexity: O(n) where n is payload size
 * Space Complexity: O(1) - Returns fixed 64-char hex string
 *
 * Payload format: "{timestamp}.{body}"
 *
 * @param secret - Webhook secret (hex string)
 * @param timestamp - Unix timestamp as string
 * @param body - Request body as string
 * @returns 64-character hex signature (SHA256)
 */
export function signWebhookPayload(
  secret: string,
  timestamp: string,
  body: string,
) {
  const payloadToSign = `${timestamp}.${body}`;
  return crypto
    .createHmac("sha256", secret)
    .update(payloadToSign)
    .digest("hex");
}
