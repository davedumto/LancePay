/**
 * Benchmark baseline for hot path helpers in routes-b _lib.
 *
 * These benchmarks establish performance baselines for critical helpers.
 * Run with: vitest bench
 *
 * Expected results (on modern hardware):
 * - Cache get/set: < 1µs per operation
 * - Rate limit check: < 1µs per operation
 * - HMAC sign: < 100µs per operation (depends on payload size)
 */

import { bench, describe } from "vitest";
import { getCacheValue, setCacheValue } from "../cache";
import { checkRateLimit, resetRateLimitBuckets } from "../rate-limit";
import { signWebhookPayload, generateWebhookSecret } from "../hmac";

describe("cache benchmarks", () => {
  bench("setCacheValue: small value", () => {
    setCacheValue("key", "value", 1000);
  });

  bench("getCacheValue: hit", () => {
    setCacheValue("key", "value", 1000);
    getCacheValue("key");
  });

  bench("getCacheValue: miss", () => {
    getCacheValue("non-existent-key");
  });

  bench("setCacheValue: large object", () => {
    const largeObj = {
      id: "123",
      data: Array.from({ length: 100 }, (_, i) => ({
        index: i,
        value: `item-${i}`,
      })),
    };
    setCacheValue("key", largeObj, 1000);
  });

  bench("getCacheValue: after many sets", () => {
    for (let i = 0; i < 1000; i++) {
      setCacheValue(`key-${i}`, `value-${i}`, 1000);
    }
    getCacheValue("key-500");
  });
});

describe("rate-limit benchmarks", () => {
  bench("checkRateLimit: first request", () => {
    resetRateLimitBuckets();
    checkRateLimit("user:1", { limit: 100, windowMs: 1000 });
  });

  bench("checkRateLimit: within limit", () => {
    checkRateLimit("user:1", { limit: 100, windowMs: 1000 });
  });

  bench("checkRateLimit: at limit", () => {
    resetRateLimitBuckets();
    for (let i = 0; i < 100; i++) {
      checkRateLimit("user:1", { limit: 100, windowMs: 1000 });
    }
    checkRateLimit("user:1", { limit: 100, windowMs: 1000 });
  });

  bench("checkRateLimit: many users", () => {
    for (let i = 0; i < 1000; i++) {
      checkRateLimit(`user:${i}`, { limit: 100, windowMs: 1000 });
    }
  });

  bench("checkRateLimit: with custom now", () => {
    const now = Date.now();
    checkRateLimit("user:1", { limit: 100, windowMs: 1000 }, now);
  });
});

describe("hmac benchmarks", () => {
  bench("generateWebhookSecret", () => {
    generateWebhookSecret();
  });

  bench("signWebhookPayload: small payload", () => {
    const secret = generateWebhookSecret();
    const timestamp = "1234567890";
    const body = '{"id":"123"}';
    signWebhookPayload(secret, timestamp, body);
  });

  bench("signWebhookPayload: medium payload", () => {
    const secret = generateWebhookSecret();
    const timestamp = "1234567890";
    const body = JSON.stringify({
      id: "123",
      data: Array.from({ length: 50 }, (_, i) => ({
        index: i,
        value: `item-${i}`,
      })),
    });
    signWebhookPayload(secret, timestamp, body);
  });

  bench("signWebhookPayload: large payload", () => {
    const secret = generateWebhookSecret();
    const timestamp = "1234567890";
    const body = JSON.stringify({
      id: "123",
      data: Array.from({ length: 1000 }, (_, i) => ({
        index: i,
        value: `item-${i}`,
      })),
    });
    signWebhookPayload(secret, timestamp, body);
  });

  bench("signWebhookPayload: reuse secret", () => {
    const secret = "a".repeat(64);
    const timestamp = "1234567890";
    const body = '{"id":"123"}';
    signWebhookPayload(secret, timestamp, body);
  });
});

describe("combined hot path benchmarks", () => {
  bench("cache + rate-limit check", () => {
    setCacheValue("key", "value", 1000);
    getCacheValue("key");
    checkRateLimit("user:1", { limit: 100, windowMs: 1000 });
  });

  bench("rate-limit + hmac sign", () => {
    checkRateLimit("user:1", { limit: 100, windowMs: 1000 });
    const secret = "a".repeat(64);
    signWebhookPayload(secret, "1234567890", '{"id":"123"}');
  });

  bench("cache + hmac sign", () => {
    setCacheValue("key", "value", 1000);
    const secret = "a".repeat(64);
    signWebhookPayload(secret, "1234567890", '{"id":"123"}');
  });
});
