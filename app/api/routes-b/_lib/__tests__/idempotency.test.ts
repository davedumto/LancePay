import { describe, it, expect, beforeEach, vi } from "vitest";
import { getIdempotentResponse, setIdempotentResponse } from "../idempotency";

describe("idempotency helpers", () => {
  beforeEach(() => {
    // Clear store by setting and getting a non-existent key
    vi.clearAllMocks();
  });

  describe("setIdempotentResponse / getIdempotentResponse", () => {
    it("stores and retrieves a response", () => {
      const response = { bodyHash: "hash1", status: 200, body: { id: "123" } };
      setIdempotentResponse("key1", response, 1000);

      const result = getIdempotentResponse("key1");
      expect(result).toEqual(expect.objectContaining(response));
    });

    it("returns null for non-existent key", () => {
      const result = getIdempotentResponse("non-existent");
      expect(result).toBeNull();
    });

    it("returns null for expired response", () => {
      const response = { bodyHash: "hash1", status: 200, body: { id: "123" } };
      setIdempotentResponse("key1", response, 100);

      vi.useFakeTimers();
      vi.advanceTimersByTime(150);

      const result = getIdempotentResponse("key1");
      expect(result).toBeNull();

      vi.useRealTimers();
    });

    it("stores different status codes", () => {
      const statuses = [200, 201, 400, 404, 500];

      for (const status of statuses) {
        const response = { bodyHash: `hash${status}`, status, body: {} };
        setIdempotentResponse(`key${status}`, response, 1000);
      }

      for (const status of statuses) {
        const result = getIdempotentResponse(`key${status}`);
        expect(result?.status).toBe(status);
      }
    });

    it("stores complex response bodies", () => {
      const body = {
        id: "123",
        nested: { data: [1, 2, 3] },
        timestamp: new Date().toISOString(),
      };
      const response = { bodyHash: "hash1", status: 200, body };
      setIdempotentResponse("key1", response, 1000);

      const result = getIdempotentResponse("key1");
      expect(result?.body).toEqual(body);
    });

    it("overwrites existing response", () => {
      const response1 = { bodyHash: "hash1", status: 200, body: { id: "1" } };
      const response2 = { bodyHash: "hash2", status: 201, body: { id: "2" } };

      setIdempotentResponse("key1", response1, 1000);
      setIdempotentResponse("key1", response2, 1000);

      const result = getIdempotentResponse("key1");
      expect(result?.status).toBe(201);
      expect(result?.body).toEqual({ id: "2" });
    });

    it("handles zero TTL", () => {
      const response = { bodyHash: "hash1", status: 200, body: {} };
      setIdempotentResponse("key1", response, 0);

      const result = getIdempotentResponse("key1");
      expect(result).toBeNull();
    });

    it("handles negative TTL", () => {
      const response = { bodyHash: "hash1", status: 200, body: {} };
      setIdempotentResponse("key1", response, -100);

      const result = getIdempotentResponse("key1");
      expect(result).toBeNull();
    });

    it("handles very large TTL", () => {
      const response = { bodyHash: "hash1", status: 200, body: {} };
      setIdempotentResponse("key1", response, 1000 * 60 * 60 * 24 * 365);

      const result = getIdempotentResponse("key1");
      expect(result).not.toBeNull();
    });

    it("isolates different keys", () => {
      const response1 = { bodyHash: "hash1", status: 200, body: { id: "1" } };
      const response2 = { bodyHash: "hash2", status: 200, body: { id: "2" } };

      setIdempotentResponse("key1", response1, 1000);
      setIdempotentResponse("key2", response2, 1000);

      expect(getIdempotentResponse("key1")?.body).toEqual({ id: "1" });
      expect(getIdempotentResponse("key2")?.body).toEqual({ id: "2" });
    });

    it("includes expiresAt in stored response", () => {
      const response = { bodyHash: "hash1", status: 200, body: {} };
      const before = Date.now();
      setIdempotentResponse("key1", response, 1000);
      const after = Date.now();

      const result = getIdempotentResponse("key1");
      expect(result?.expiresAt).toBeGreaterThanOrEqual(before + 1000);
      expect(result?.expiresAt).toBeLessThanOrEqual(after + 1000);
    });
  });

  describe("real-world scenarios", () => {
    it("handles idempotent POST requests", () => {
      const idempotencyKey = "req:user:123:invoice:create";
      const response = {
        bodyHash: "abc123",
        status: 201,
        body: { id: "inv-456", amount: 100 },
      };

      // First request
      setIdempotentResponse(idempotencyKey, response, 24 * 60 * 60 * 1000); // 24 hours

      // Retry with same key
      const cachedResponse = getIdempotentResponse(idempotencyKey);
      expect(cachedResponse?.body).toEqual(response.body);
      expect(cachedResponse?.status).toBe(201);
    });

    it("handles multiple concurrent idempotent requests", () => {
      const keys = Array.from({ length: 100 }, (_, i) => `req:${i}`);

      for (const key of keys) {
        const response = {
          bodyHash: `hash${key}`,
          status: 200,
          body: { id: key },
        };
        setIdempotentResponse(key, response, 1000);
      }

      for (const key of keys) {
        const result = getIdempotentResponse(key);
        expect(result?.body.id).toBe(key);
      }
    });

    it("handles expiry of old requests", () => {
      vi.useFakeTimers();
      const now = Date.now();

      const response = {
        bodyHash: "hash1",
        status: 200,
        body: { id: "123" },
      };

      setIdempotentResponse("key1", response, 1000);

      // Before expiry
      vi.setSystemTime(now + 500);
      expect(getIdempotentResponse("key1")).not.toBeNull();

      // After expiry
      vi.setSystemTime(now + 1001);
      expect(getIdempotentResponse("key1")).toBeNull();

      vi.useRealTimers();
    });
  });

  describe("complexity", () => {
    it("getIdempotentResponse: O(1) lookup", () => {
      // Set up many responses
      for (let i = 0; i < 10000; i++) {
        const response = {
          bodyHash: `hash${i}`,
          status: 200,
          body: { id: i },
        };
        setIdempotentResponse(`key${i}`, response, 1000);
      }

      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        getIdempotentResponse("key5000");
      }
      const duration = performance.now() - start;

      // Should be very fast (< 10ms for 1000 lookups)
      expect(duration).toBeLessThan(10);
    });

    it("setIdempotentResponse: O(1) insertion", () => {
      const start = performance.now();
      for (let i = 0; i < 10000; i++) {
        const response = {
          bodyHash: `hash${i}`,
          status: 200,
          body: { id: i },
        };
        setIdempotentResponse(`key${i}`, response, 1000);
      }
      const duration = performance.now() - start;

      // Should be very fast (< 100ms for 10k insertions)
      expect(duration).toBeLessThan(100);
    });
  });
});
