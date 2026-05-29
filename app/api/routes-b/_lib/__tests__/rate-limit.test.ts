import { describe, it, expect, beforeEach } from "vitest";
import {
  checkRateLimit,
  resetRateLimitBuckets,
  rateLimit,
} from "../rate-limit";

describe("rate-limit helpers", () => {
  beforeEach(() => {
    resetRateLimitBuckets();
  });

  describe("checkRateLimit", () => {
    it("allows first request", () => {
      const result = checkRateLimit("user:1", { limit: 10, windowMs: 1000 });
      expect(result).toEqual({ allowed: true });
    });

    it("allows requests within limit", () => {
      for (let i = 0; i < 10; i++) {
        const result = checkRateLimit("user:1", { limit: 10, windowMs: 1000 });
        expect(result).toEqual({ allowed: true });
      }
    });

    it("rejects requests exceeding limit", () => {
      for (let i = 0; i < 10; i++) {
        checkRateLimit("user:1", { limit: 10, windowMs: 1000 });
      }

      const result = checkRateLimit("user:1", { limit: 10, windowMs: 1000 });
      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty("retryAfter");
    });

    it("returns correct retryAfter value", () => {
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        checkRateLimit("user:1", { limit: 10, windowMs: 1000 }, now);
      }

      const result = checkRateLimit(
        "user:1",
        { limit: 10, windowMs: 1000 },
        now + 500,
      );
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.retryAfter).toBeGreaterThan(0);
        expect(result.retryAfter).toBeLessThanOrEqual(1);
      }
    });

    it("resets bucket after window expires", () => {
      const now = Date.now();

      // Fill bucket
      for (let i = 0; i < 10; i++) {
        checkRateLimit("user:1", { limit: 10, windowMs: 1000 }, now);
      }

      // Should be rate limited
      let result = checkRateLimit("user:1", { limit: 10, windowMs: 1000 }, now);
      expect(result.allowed).toBe(false);

      // After window expires, should allow again
      result = checkRateLimit(
        "user:1",
        { limit: 10, windowMs: 1000 },
        now + 1001,
      );
      expect(result.allowed).toBe(true);
    });

    it("isolates different keys", () => {
      for (let i = 0; i < 10; i++) {
        checkRateLimit("user:1", { limit: 10, windowMs: 1000 });
      }

      // user:1 is rate limited
      let result = checkRateLimit("user:1", { limit: 10, windowMs: 1000 });
      expect(result.allowed).toBe(false);

      // user:2 should still be allowed
      result = checkRateLimit("user:2", { limit: 10, windowMs: 1000 });
      expect(result.allowed).toBe(true);
    });

    it("handles limit of 1", () => {
      const result1 = checkRateLimit("user:1", { limit: 1, windowMs: 1000 });
      expect(result1.allowed).toBe(true);

      const result2 = checkRateLimit("user:1", { limit: 1, windowMs: 1000 });
      expect(result2.allowed).toBe(false);
    });

    it("handles limit of 0", () => {
      const result = checkRateLimit("user:1", { limit: 0, windowMs: 1000 });
      expect(result.allowed).toBe(false);
    });

    it("handles very large limits", () => {
      for (let i = 0; i < 10000; i++) {
        const result = checkRateLimit("user:1", {
          limit: 10000,
          windowMs: 1000,
        });
        expect(result.allowed).toBe(true);
      }

      const result = checkRateLimit("user:1", { limit: 10000, windowMs: 1000 });
      expect(result.allowed).toBe(false);
    });

    it("handles very short windows", () => {
      const now = Date.now();

      const result1 = checkRateLimit("user:1", { limit: 1, windowMs: 1 }, now);
      expect(result1.allowed).toBe(true);

      const result2 = checkRateLimit("user:1", { limit: 1, windowMs: 1 }, now);
      expect(result2.allowed).toBe(false);

      // After window expires
      const result3 = checkRateLimit(
        "user:1",
        { limit: 1, windowMs: 1 },
        now + 2,
      );
      expect(result3.allowed).toBe(true);
    });

    it("handles very long windows", () => {
      const now = Date.now();
      const oneYear = 365 * 24 * 60 * 60 * 1000;

      for (let i = 0; i < 10; i++) {
        checkRateLimit("user:1", { limit: 10, windowMs: oneYear }, now);
      }

      const result = checkRateLimit(
        "user:1",
        { limit: 10, windowMs: oneYear },
        now + oneYear - 1,
      );
      expect(result.allowed).toBe(false);
    });

    it("uses provided now parameter", () => {
      const now = 1000000;
      const result = checkRateLimit(
        "user:1",
        { limit: 1, windowMs: 1000 },
        now,
      );
      expect(result.allowed).toBe(true);
    });

    it("retryAfter is at least 1 second", () => {
      const now = Date.now();

      for (let i = 0; i < 10; i++) {
        checkRateLimit("user:1", { limit: 10, windowMs: 1000 }, now);
      }

      const result = checkRateLimit(
        "user:1",
        { limit: 10, windowMs: 1000 },
        now + 999,
      );
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.retryAfter).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe("resetRateLimitBuckets", () => {
    it("clears all buckets", () => {
      checkRateLimit("user:1", { limit: 1, windowMs: 1000 });
      checkRateLimit("user:2", { limit: 1, windowMs: 1000 });

      // Both should be rate limited
      let result1 = checkRateLimit("user:1", { limit: 1, windowMs: 1000 });
      let result2 = checkRateLimit("user:2", { limit: 1, windowMs: 1000 });
      expect(result1.allowed).toBe(false);
      expect(result2.allowed).toBe(false);

      // Reset
      resetRateLimitBuckets();

      // Both should be allowed again
      result1 = checkRateLimit("user:1", { limit: 1, windowMs: 1000 });
      result2 = checkRateLimit("user:2", { limit: 1, windowMs: 1000 });
      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
    });
  });

  describe("rateLimit async wrapper", () => {
    it("returns allowed true", async () => {
      const result = await rateLimit("user:1", 10, 1000);
      expect(result.allowed).toBe(true);
    });

    it("returns allowed false with resetTime", async () => {
      for (let i = 0; i < 10; i++) {
        await rateLimit("user:1", 10, 1000);
      }

      const result = await rateLimit("user:1", 10, 1000);
      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty("resetTime");
      expect(typeof result.resetTime).toBe("string");
    });

    it("resetTime is a valid ISO string", async () => {
      for (let i = 0; i < 10; i++) {
        await rateLimit("user:1", 10, 1000);
      }

      const result = await rateLimit("user:1", 10, 1000);
      if (!result.allowed) {
        const date = new Date(result.resetTime);
        expect(date.getTime()).toBeGreaterThan(Date.now());
      }
    });
  });

  describe("real-world scenarios", () => {
    it("handles API rate limiting (100 req/min)", () => {
      const limit = 100;
      const windowMs = 60 * 1000;

      // First 100 should succeed
      for (let i = 0; i < 100; i++) {
        const result = checkRateLimit("api:user:1", { limit, windowMs });
        expect(result.allowed).toBe(true);
      }

      // 101st should fail
      const result = checkRateLimit("api:user:1", { limit, windowMs });
      expect(result.allowed).toBe(false);
    });

    it("handles per-IP rate limiting", () => {
      const ips = ["192.168.1.1", "192.168.1.2", "192.168.1.3"];

      for (const ip of ips) {
        for (let i = 0; i < 10; i++) {
          const result = checkRateLimit(`ip:${ip}`, {
            limit: 10,
            windowMs: 1000,
          });
          expect(result.allowed).toBe(true);
        }

        // Each IP should be rate limited independently
        const result = checkRateLimit(`ip:${ip}`, {
          limit: 10,
          windowMs: 1000,
        });
        expect(result.allowed).toBe(false);
      }
    });

    it("handles sliding window behavior", () => {
      const now = Date.now();
      const windowMs = 1000;

      // Fill first window
      for (let i = 0; i < 10; i++) {
        checkRateLimit("user:1", { limit: 10, windowMs }, now);
      }

      // Should be rate limited
      let result = checkRateLimit("user:1", { limit: 10, windowMs }, now + 500);
      expect(result.allowed).toBe(false);

      // After window expires, should allow again
      result = checkRateLimit("user:1", { limit: 10, windowMs }, now + 1001);
      expect(result.allowed).toBe(true);
    });
  });

  describe("complexity", () => {
    it("checkRateLimit: O(1) operation", () => {
      // Set up many buckets
      for (let i = 0; i < 10000; i++) {
        checkRateLimit(`user:${i}`, { limit: 10, windowMs: 1000 });
      }

      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        checkRateLimit("user:5000", { limit: 10, windowMs: 1000 });
      }
      const duration = performance.now() - start;

      // Should be very fast (< 10ms for 1000 operations)
      expect(duration).toBeLessThan(10);
    });
  });
});
