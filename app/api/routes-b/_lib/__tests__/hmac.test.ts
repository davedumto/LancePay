import { describe, it, expect } from "vitest";
import { generateWebhookSecret, signWebhookPayload } from "../hmac";

describe("hmac helpers", () => {
  describe("generateWebhookSecret", () => {
    it("generates a secret", () => {
      const secret = generateWebhookSecret();
      expect(secret).toBeDefined();
      expect(typeof secret).toBe("string");
    });

    it("generates hex string", () => {
      const secret = generateWebhookSecret();
      expect(/^[0-9a-f]+$/.test(secret)).toBe(true);
    });

    it("generates 64-character string (32 bytes in hex)", () => {
      const secret = generateWebhookSecret();
      expect(secret).toHaveLength(64);
    });

    it("generates unique secrets", () => {
      const secret1 = generateWebhookSecret();
      const secret2 = generateWebhookSecret();
      expect(secret1).not.toBe(secret2);
    });

    it("generates cryptographically random secrets", () => {
      const secrets = new Set();
      for (let i = 0; i < 100; i++) {
        secrets.add(generateWebhookSecret());
      }
      expect(secrets.size).toBe(100);
    });
  });

  describe("signWebhookPayload", () => {
    it("signs payload with secret", () => {
      const secret = "test-secret";
      const timestamp = "1234567890";
      const body = '{"id":"123"}';

      const signature = signWebhookPayload(secret, timestamp, body);

      expect(signature).toBeDefined();
      expect(typeof signature).toBe("string");
    });

    it("generates hex signature", () => {
      const secret = "test-secret";
      const timestamp = "1234567890";
      const body = '{"id":"123"}';

      const signature = signWebhookPayload(secret, timestamp, body);

      expect(/^[0-9a-f]+$/.test(signature)).toBe(true);
    });

    it("generates 64-character signature (SHA256 in hex)", () => {
      const secret = "test-secret";
      const timestamp = "1234567890";
      const body = '{"id":"123"}';

      const signature = signWebhookPayload(secret, timestamp, body);

      expect(signature).toHaveLength(64);
    });

    it("produces deterministic signature", () => {
      const secret = "test-secret";
      const timestamp = "1234567890";
      const body = '{"id":"123"}';

      const sig1 = signWebhookPayload(secret, timestamp, body);
      const sig2 = signWebhookPayload(secret, timestamp, body);

      expect(sig1).toBe(sig2);
    });

    it("produces different signature for different secret", () => {
      const timestamp = "1234567890";
      const body = '{"id":"123"}';

      const sig1 = signWebhookPayload("secret1", timestamp, body);
      const sig2 = signWebhookPayload("secret2", timestamp, body);

      expect(sig1).not.toBe(sig2);
    });

    it("produces different signature for different timestamp", () => {
      const secret = "test-secret";
      const body = '{"id":"123"}';

      const sig1 = signWebhookPayload(secret, "1234567890", body);
      const sig2 = signWebhookPayload(secret, "1234567891", body);

      expect(sig1).not.toBe(sig2);
    });

    it("produces different signature for different body", () => {
      const secret = "test-secret";
      const timestamp = "1234567890";

      const sig1 = signWebhookPayload(secret, timestamp, '{"id":"123"}');
      const sig2 = signWebhookPayload(secret, timestamp, '{"id":"124"}');

      expect(sig1).not.toBe(sig2);
    });

    it("includes timestamp in signature", () => {
      const secret = "test-secret";
      const body = '{"id":"123"}';

      const sig1 = signWebhookPayload(secret, "1000", body);
      const sig2 = signWebhookPayload(secret, "2000", body);

      expect(sig1).not.toBe(sig2);
    });

    it("handles empty body", () => {
      const secret = "test-secret";
      const timestamp = "1234567890";

      const signature = signWebhookPayload(secret, timestamp, "");

      expect(signature).toHaveLength(64);
    });

    it("handles empty secret", () => {
      const timestamp = "1234567890";
      const body = '{"id":"123"}';

      const signature = signWebhookPayload("", timestamp, body);

      expect(signature).toHaveLength(64);
    });

    it("handles special characters in body", () => {
      const secret = "test-secret";
      const timestamp = "1234567890";
      const body = '{"message":"Hello\\nWorld\\t!@#$%^&*()"}';

      const signature = signWebhookPayload(secret, timestamp, body);

      expect(signature).toHaveLength(64);
    });

    it("handles unicode in body", () => {
      const secret = "test-secret";
      const timestamp = "1234567890";
      const body = '{"message":"你好世界🌍"}';

      const signature = signWebhookPayload(secret, timestamp, body);

      expect(signature).toHaveLength(64);
    });

    it("uses timestamp.body format", () => {
      const secret = "test-secret";
      const timestamp = "1234567890";
      const body = "test-body";

      // The signature should be based on "1234567890.test-body"
      const signature = signWebhookPayload(secret, timestamp, body);

      // Verify by signing the same payload manually
      import("crypto").then((cryptoModule) => {
        const crypto = cryptoModule.default;
        const expectedSig = crypto
          .createHmac("sha256", secret)
          .update(`${timestamp}.${body}`)
          .digest("hex");

        expect(signature).toBe(expectedSig);
      });
    });
  });

  describe("real-world scenarios", () => {
    it("webhook signature verification flow", () => {
      // Generate secret for webhook
      const secret = generateWebhookSecret();

      // Sign payload
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const body = JSON.stringify({ id: "inv-123", amount: 100 });
      const signature = signWebhookPayload(secret, timestamp, body);

      // Verify signature (simulate receiver)
      const receivedSignature = signWebhookPayload(secret, timestamp, body);
      expect(signature).toBe(receivedSignature);
    });

    it("handles multiple webhook secrets", () => {
      const secrets = [
        generateWebhookSecret(),
        generateWebhookSecret(),
        generateWebhookSecret(),
      ];

      const timestamp = "1234567890";
      const body = '{"id":"123"}';

      const signatures = secrets.map((secret) =>
        signWebhookPayload(secret, timestamp, body),
      );

      // All signatures should be different
      const uniqueSigs = new Set(signatures);
      expect(uniqueSigs.size).toBe(3);
    });

    it("handles large payloads", () => {
      const secret = generateWebhookSecret();
      const timestamp = "1234567890";
      const largeBody = JSON.stringify({
        data: "x".repeat(100000), // 100KB
      });

      const signature = signWebhookPayload(secret, timestamp, largeBody);

      expect(signature).toHaveLength(64);
    });
  });

  describe("complexity", () => {
    it("generateWebhookSecret: O(1) generation", () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        generateWebhookSecret();
      }
      const duration = performance.now() - start;

      // Should be fast (< 100ms for 1000 generations)
      expect(duration).toBeLessThan(100);
    });

    it("signWebhookPayload: O(n) where n is payload size", () => {
      const secret = generateWebhookSecret();
      const timestamp = "1234567890";

      // Small payload
      const smallBody = "x".repeat(100);
      const startSmall = performance.now();
      for (let i = 0; i < 1000; i++) {
        signWebhookPayload(secret, timestamp, smallBody);
      }
      const durationSmall = performance.now() - startSmall;

      // Large payload
      const largeBody = "x".repeat(10000);
      const startLarge = performance.now();
      for (let i = 0; i < 1000; i++) {
        signWebhookPayload(secret, timestamp, largeBody);
      }
      const durationLarge = performance.now() - startLarge;

      // Large payload should take longer (roughly proportional to size)
      expect(durationLarge).toBeGreaterThan(durationSmall);
    });
  });
});
