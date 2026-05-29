import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getCacheValue,
  setCacheValue,
  deleteCacheValue,
  clearCache,
  getCachedValue,
  setCachedValue,
  deleteCachedValue,
} from "../cache";

describe("cache helpers", () => {
  beforeEach(() => {
    clearCache();
  });

  describe("getCacheValue / setCacheValue", () => {
    it("stores and retrieves a value", () => {
      setCacheValue("key1", "value1", 1000);
      const result = getCacheValue("key1");
      expect(result).toBe("value1");
    });

    it("returns null for non-existent key", () => {
      const result = getCacheValue("non-existent");
      expect(result).toBeNull();
    });

    it("returns null for expired value", () => {
      setCacheValue("key1", "value1", 100);
      // Wait for expiry
      vi.useFakeTimers();
      vi.advanceTimersByTime(150);
      const result = getCacheValue("key1");
      expect(result).toBeNull();
      vi.useRealTimers();
    });

    it("stores different types", () => {
      setCacheValue("string", "hello", 1000);
      setCacheValue("number", 42, 1000);
      setCacheValue("object", { a: 1, b: 2 }, 1000);
      setCacheValue("array", [1, 2, 3], 1000);

      expect(getCacheValue("string")).toBe("hello");
      expect(getCacheValue("number")).toBe(42);
      expect(getCacheValue("object")).toEqual({ a: 1, b: 2 });
      expect(getCacheValue("array")).toEqual([1, 2, 3]);
    });

    it("overwrites existing value", () => {
      setCacheValue("key1", "value1", 1000);
      setCacheValue("key1", "value2", 1000);
      expect(getCacheValue("key1")).toBe("value2");
    });

    it("handles zero TTL", () => {
      setCacheValue("key1", "value1", 0);
      const result = getCacheValue("key1");
      expect(result).toBeNull();
    });

    it("handles negative TTL", () => {
      setCacheValue("key1", "value1", -100);
      const result = getCacheValue("key1");
      expect(result).toBeNull();
    });

    it("handles very large TTL", () => {
      setCacheValue("key1", "value1", 1000 * 60 * 60 * 24 * 365); // 1 year
      const result = getCacheValue("key1");
      expect(result).toBe("value1");
    });

    it("stores null values", () => {
      setCacheValue("key1", null, 1000);
      const result = getCacheValue("key1");
      expect(result).toBeNull();
    });

    it("stores undefined values", () => {
      setCacheValue("key1", undefined, 1000);
      const result = getCacheValue("key1");
      expect(result).toBeUndefined();
    });
  });

  describe("deleteCacheValue", () => {
    it("removes a cached value", () => {
      setCacheValue("key1", "value1", 1000);
      expect(getCacheValue("key1")).toBe("value1");

      deleteCacheValue("key1");
      expect(getCacheValue("key1")).toBeNull();
    });

    it("handles deleting non-existent key", () => {
      expect(() => deleteCacheValue("non-existent")).not.toThrow();
    });

    it("does not affect other keys", () => {
      setCacheValue("key1", "value1", 1000);
      setCacheValue("key2", "value2", 1000);

      deleteCacheValue("key1");

      expect(getCacheValue("key1")).toBeNull();
      expect(getCacheValue("key2")).toBe("value2");
    });
  });

  describe("clearCache", () => {
    it("clears all cached values", () => {
      setCacheValue("key1", "value1", 1000);
      setCacheValue("key2", "value2", 1000);
      setCacheValue("key3", "value3", 1000);

      clearCache();

      expect(getCacheValue("key1")).toBeNull();
      expect(getCacheValue("key2")).toBeNull();
      expect(getCacheValue("key3")).toBeNull();
    });

    it("handles clearing empty cache", () => {
      expect(() => clearCache()).not.toThrow();
    });
  });

  describe("getCachedValue / setCachedValue", () => {
    it("stores and retrieves a value", () => {
      setCachedValue("key1", "value1", 1000);
      const result = getCachedValue("key1");
      expect(result).toBe("value1");
    });

    it("returns null for non-existent key", () => {
      const result = getCachedValue("non-existent");
      expect(result).toBeNull();
    });

    it("returns null for expired value", () => {
      setCachedValue("key1", "value1", 100);
      vi.useFakeTimers();
      vi.advanceTimersByTime(150);
      const result = getCachedValue("key1");
      expect(result).toBeNull();
      vi.useRealTimers();
    });

    it("stores different types", () => {
      setCachedValue("string", "hello", 1000);
      setCachedValue("number", 42, 1000);
      setCachedValue("object", { a: 1, b: 2 }, 1000);

      expect(getCachedValue("string")).toBe("hello");
      expect(getCachedValue("number")).toBe(42);
      expect(getCachedValue("object")).toEqual({ a: 1, b: 2 });
    });
  });

  describe("deleteCachedValue", () => {
    it("removes a cached value", () => {
      setCachedValue("key1", "value1", 1000);
      expect(getCachedValue("key1")).toBe("value1");

      deleteCachedValue("key1");
      expect(getCachedValue("key1")).toBeNull();
    });

    it("handles deleting non-existent key", () => {
      expect(() => deleteCachedValue("non-existent")).not.toThrow();
    });
  });

  describe("edge cases", () => {
    it("handles concurrent operations", () => {
      for (let i = 0; i < 100; i++) {
        setCacheValue(`key${i}`, `value${i}`, 1000);
      }

      for (let i = 0; i < 100; i++) {
        expect(getCacheValue(`key${i}`)).toBe(`value${i}`);
      }
    });

    it("handles special characters in keys", () => {
      const specialKeys = [
        "key:with:colons",
        "key/with/slashes",
        "key.with.dots",
        "key-with-dashes",
        "key_with_underscores",
        "key with spaces",
      ];

      for (const key of specialKeys) {
        setCacheValue(key, "value", 1000);
        expect(getCacheValue(key)).toBe("value");
      }
    });

    it("handles large values", () => {
      const largeValue = "x".repeat(1000000); // 1MB string
      setCacheValue("large", largeValue, 1000);
      expect(getCacheValue("large")).toBe(largeValue);
    });

    it("handles rapid set/get cycles", () => {
      for (let i = 0; i < 1000; i++) {
        setCacheValue("key", i, 1000);
        expect(getCacheValue("key")).toBe(i);
      }
    });
  });

  describe("complexity", () => {
    it("getCacheValue: O(1) lookup", () => {
      // Set up cache with many entries
      for (let i = 0; i < 10000; i++) {
        setCacheValue(`key${i}`, `value${i}`, 1000);
      }

      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        getCacheValue("key5000");
      }
      const duration = performance.now() - start;

      // Should be very fast (< 10ms for 1000 lookups)
      expect(duration).toBeLessThan(10);
    });

    it("setCacheValue: O(1) insertion", () => {
      const start = performance.now();
      for (let i = 0; i < 10000; i++) {
        setCacheValue(`key${i}`, `value${i}`, 1000);
      }
      const duration = performance.now() - start;

      // Should be very fast (< 100ms for 10k insertions)
      expect(duration).toBeLessThan(100);
    });
  });
});
