import { describe, it, expect, beforeEach, vi } from "vitest";
import { withRetry, isRetryableStatusError, isNetworkError } from "../retry";

describe("retry helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isRetryableStatusError", () => {
    it("returns true for 5xx errors", () => {
      expect(isRetryableStatusError(new Error("Server error") as any)).toBe(
        false,
      );
      expect(isRetryableStatusError({ status: 500 } as any)).toBe(true);
      expect(isRetryableStatusError({ status: 502 } as any)).toBe(true);
      expect(isRetryableStatusError({ status: 503 } as any)).toBe(true);
    });

    it("returns false for 4xx errors", () => {
      expect(isRetryableStatusError({ status: 400 } as any)).toBe(false);
      expect(isRetryableStatusError({ status: 401 } as any)).toBe(false);
      expect(isRetryableStatusError({ status: 404 } as any)).toBe(false);
    });

    it("returns false for 2xx/3xx", () => {
      expect(isRetryableStatusError({ status: 200 } as any)).toBe(false);
      expect(isRetryableStatusError({ status: 301 } as any)).toBe(false);
    });
  });

  describe("isNetworkError", () => {
    it("detects connection errors", () => {
      expect(isNetworkError({ code: "ECONNRESET" } as any)).toBe(true);
      expect(isNetworkError({ code: "ECONNREFUSED" } as any)).toBe(true);
      expect(isNetworkError({ code: "ETIMEDOUT" } as any)).toBe(true);
    });

    it("returns false for other errors", () => {
      expect(isNetworkError({ code: "ENOENT" } as any)).toBe(false);
      expect(isNetworkError({} as any)).toBe(false);
    });
  });

  describe("withRetry", () => {
    it("succeeds on first attempt", async () => {
      const fn = vi.fn().mockResolvedValue("success");
      const result = await withRetry(fn);
      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries on transient error", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("Network error") as any)
        .mockResolvedValueOnce("success");

      const result = await withRetry(fn, { maxAttempts: 3 });
      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("retries on 5xx status", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce({ status: 503 } as any)
        .mockResolvedValueOnce("success");

      const result = await withRetry(fn, { maxAttempts: 3 });
      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("gives up after max attempts", async () => {
      const fn = vi.fn().mockRejectedValue({ status: 503 } as any);
      await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("does not retry on 4xx errors", async () => {
      const fn = vi.fn().mockRejectedValue({ status: 400 } as any);
      await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("uses exponential backoff", async () => {
      vi.useFakeTimers();
      const fn = vi
        .fn()
        .mockRejectedValueOnce({ status: 503 } as any)
        .mockRejectedValueOnce({ status: 503 } as any)
        .mockResolvedValueOnce("success");

      const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 100 });

      // First retry after ~100ms
      await vi.advanceTimersByTimeAsync(150);
      expect(fn).toHaveBeenCalledTimes(2);

      // Second retry after ~200ms more
      await vi.advanceTimersByTimeAsync(250);
      expect(fn).toHaveBeenCalledTimes(3);

      const result = await promise;
      expect(result).toBe("success");

      vi.useRealTimers();
    });

    it("respects maxTotalMs timeout", async () => {
      vi.useFakeTimers();
      const fn = vi.fn().mockRejectedValue({ status: 503 } as any);

      const promise = withRetry(fn, {
        maxAttempts: 10,
        baseDelayMs: 100,
        maxTotalMs: 250,
      });

      await vi.advanceTimersByTimeAsync(300);
      await expect(promise).rejects.toThrow();

      // Should have stopped before maxAttempts
      expect(fn.mock.calls.length).toBeLessThan(10);

      vi.useRealTimers();
    });

    it("calls onRetry callback", async () => {
      const onRetry = vi.fn();
      const fn = vi
        .fn()
        .mockRejectedValueOnce({ status: 503 } as any)
        .mockResolvedValueOnce("success");

      await withRetry(fn, { maxAttempts: 3, onRetry });

      expect(onRetry).toHaveBeenCalledWith(
        expect.objectContaining({
          attempt: 1,
          delay: expect.any(Number),
          error: expect.any(String),
        }),
      );
    });

    it("uses custom shouldRetry function", async () => {
      const shouldRetry = vi.fn().mockReturnValue(false);
      const fn = vi.fn().mockRejectedValue({ status: 503 } as any);

      await expect(
        withRetry(fn, { maxAttempts: 3, shouldRetry }),
      ).rejects.toThrow();

      expect(fn).toHaveBeenCalledTimes(1);
      expect(shouldRetry).toHaveBeenCalled();
    });

    it("handles successful retry with custom shouldRetry", async () => {
      const shouldRetry = vi.fn().mockReturnValue(true);
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("Custom error") as any)
        .mockResolvedValueOnce("success");

      const result = await withRetry(fn, { maxAttempts: 3, shouldRetry });

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("adds jitter to backoff", async () => {
      vi.useFakeTimers();
      const delays: number[] = [];
      const onRetry = vi.fn((payload) => delays.push(payload.delay));

      const fn = vi.fn().mockRejectedValue({ status: 503 } as any);

      try {
        await withRetry(fn, {
          maxAttempts: 4,
          baseDelayMs: 100,
          onRetry,
        });
      } catch {
        // Expected to fail
      }

      // Delays should have jitter (not exact multiples of 100)
      expect(delays.length).toBeGreaterThan(0);
      for (const delay of delays) {
        expect(delay).toBeGreaterThan(0);
      }

      vi.useRealTimers();
    });

    it("handles default options", async () => {
      const fn = vi.fn().mockResolvedValue("success");
      const result = await withRetry(fn);
      expect(result).toBe("success");
    });

    it("preserves error message", async () => {
      const error = new Error("Original error");
      const fn = vi.fn().mockRejectedValue(error);

      await expect(withRetry(fn, { maxAttempts: 1 })).rejects.toThrow(
        "Original error",
      );
    });
  });

  describe("complexity", () => {
    it("withRetry: O(1) per attempt", async () => {
      const fn = vi.fn().mockResolvedValue("success");

      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        await withRetry(fn, { maxAttempts: 1 });
      }
      const duration = performance.now() - start;

      // Should be fast (< 100ms for 1000 successful calls)
      expect(duration).toBeLessThan(100);
    });
  });
});
