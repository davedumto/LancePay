import { describe, it, expect, beforeEach } from "vitest";
import {
  deadLetterQueue,
  shouldDeadLetter,
  pushToDeadLetter,
} from "../dead-letter";

describe("dead-letter helpers", () => {
  beforeEach(() => {
    deadLetterQueue.clear("webhook-1");
    deadLetterQueue.clear("webhook-2");
  });

  describe("shouldDeadLetter", () => {
    it("returns true when status is failed and attempts >= 3", () => {
      expect(shouldDeadLetter("failed", 3)).toBe(true);
      expect(shouldDeadLetter("failed", 4)).toBe(true);
      expect(shouldDeadLetter("failed", 10)).toBe(true);
    });

    it("returns false when attempts < 3", () => {
      expect(shouldDeadLetter("failed", 1)).toBe(false);
      expect(shouldDeadLetter("failed", 2)).toBe(false);
    });

    it("returns false when status is not failed", () => {
      expect(shouldDeadLetter("success", 3)).toBe(false);
      expect(shouldDeadLetter("pending", 3)).toBe(false);
      expect(shouldDeadLetter("retrying", 3)).toBe(false);
    });
  });

  describe("DeadLetterQueue.push", () => {
    it("adds event to queue", () => {
      const event = {
        eventType: "invoice.paid",
        payload: '{"id":"123"}',
        attemptCount: 3,
      };

      deadLetterQueue.push("webhook-1", event);

      const list = deadLetterQueue.list("webhook-1");
      expect(list).toHaveLength(1);
      expect(list[0].eventType).toBe("invoice.paid");
    });

    it("generates unique IDs", () => {
      const event = {
        eventType: "invoice.paid",
        payload: '{"id":"123"}',
        attemptCount: 3,
      };

      deadLetterQueue.push("webhook-1", event);
      deadLetterQueue.push("webhook-1", event);

      const list = deadLetterQueue.list("webhook-1");
      expect(list[0].id).not.toBe(list[1].id);
    });

    it("sets timestamp", () => {
      const event = {
        eventType: "invoice.paid",
        payload: '{"id":"123"}',
        attemptCount: 3,
      };

      const before = new Date();
      deadLetterQueue.push("webhook-1", event);
      const after = new Date();

      const list = deadLetterQueue.list("webhook-1");
      expect(list[0].timestamp.getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      );
      expect(list[0].timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it("enforces max entries per webhook (1000)", () => {
      const event = {
        eventType: "invoice.paid",
        payload: '{"id":"123"}',
        attemptCount: 3,
      };

      // Add 1001 events
      for (let i = 0; i < 1001; i++) {
        deadLetterQueue.push("webhook-1", event);
      }

      const list = deadLetterQueue.list("webhook-1");
      expect(list).toHaveLength(1000);
    });

    it("removes oldest entry when cap is reached", () => {
      const event1 = {
        eventType: "invoice.paid",
        payload: '{"id":"1"}',
        attemptCount: 3,
      };
      const event2 = {
        eventType: "invoice.paid",
        payload: '{"id":"2"}',
        attemptCount: 3,
      };

      // Add 1000 of event1
      for (let i = 0; i < 1000; i++) {
        deadLetterQueue.push("webhook-1", event1);
      }

      const firstId = deadLetterQueue.list("webhook-1")[0].id;

      // Add event2, should evict oldest event1
      deadLetterQueue.push("webhook-1", event2);

      const list = deadLetterQueue.list("webhook-1");
      expect(list).toHaveLength(1000);
      expect(list[0].id).not.toBe(firstId);
      expect(list[list.length - 1].payload).toBe('{"id":"2"}');
    });

    it("isolates queues per webhook", () => {
      const event = {
        eventType: "invoice.paid",
        payload: '{"id":"123"}',
        attemptCount: 3,
      };

      deadLetterQueue.push("webhook-1", event);
      deadLetterQueue.push("webhook-2", event);

      expect(deadLetterQueue.list("webhook-1")).toHaveLength(1);
      expect(deadLetterQueue.list("webhook-2")).toHaveLength(1);
    });

    it("stores optional fields", () => {
      const event = {
        eventType: "invoice.paid",
        payload: '{"id":"123"}',
        attemptCount: 3,
        lastError: "Connection timeout",
        lastStatusCode: 504,
      };

      deadLetterQueue.push("webhook-1", event);

      const list = deadLetterQueue.list("webhook-1");
      expect(list[0].lastError).toBe("Connection timeout");
      expect(list[0].lastStatusCode).toBe(504);
    });
  });

  describe("DeadLetterQueue.list", () => {
    it("returns empty array for non-existent webhook", () => {
      const list = deadLetterQueue.list("non-existent");
      expect(list).toEqual([]);
    });

    it("returns all events for webhook", () => {
      const event = {
        eventType: "invoice.paid",
        payload: '{"id":"123"}',
        attemptCount: 3,
      };

      for (let i = 0; i < 5; i++) {
        deadLetterQueue.push("webhook-1", event);
      }

      const list = deadLetterQueue.list("webhook-1");
      expect(list).toHaveLength(5);
    });
  });

  describe("DeadLetterQueue.replay", () => {
    it("removes and returns event", () => {
      const event = {
        eventType: "invoice.paid",
        payload: '{"id":"123"}',
        attemptCount: 3,
      };

      deadLetterQueue.push("webhook-1", event);
      const list = deadLetterQueue.list("webhook-1");
      const eventId = list[0].id;

      const replayed = deadLetterQueue.replay("webhook-1", eventId);

      expect(replayed?.id).toBe(eventId);
      expect(deadLetterQueue.list("webhook-1")).toHaveLength(0);
    });

    it("returns null for non-existent event", () => {
      const result = deadLetterQueue.replay("webhook-1", "non-existent");
      expect(result).toBeNull();
    });

    it("returns null for non-existent webhook", () => {
      const result = deadLetterQueue.replay("non-existent", "event-id");
      expect(result).toBeNull();
    });

    it("removes webhook entry when queue becomes empty", () => {
      const event = {
        eventType: "invoice.paid",
        payload: '{"id":"123"}',
        attemptCount: 3,
      };

      deadLetterQueue.push("webhook-1", event);
      const list = deadLetterQueue.list("webhook-1");
      const eventId = list[0].id;

      deadLetterQueue.replay("webhook-1", eventId);

      // Replaying again should return null
      const result = deadLetterQueue.replay("webhook-1", eventId);
      expect(result).toBeNull();
    });
  });

  describe("DeadLetterQueue.clear", () => {
    it("removes all events for webhook", () => {
      const event = {
        eventType: "invoice.paid",
        payload: '{"id":"123"}',
        attemptCount: 3,
      };

      for (let i = 0; i < 5; i++) {
        deadLetterQueue.push("webhook-1", event);
      }

      deadLetterQueue.clear("webhook-1");

      expect(deadLetterQueue.list("webhook-1")).toHaveLength(0);
    });

    it("does not affect other webhooks", () => {
      const event = {
        eventType: "invoice.paid",
        payload: '{"id":"123"}',
        attemptCount: 3,
      };

      deadLetterQueue.push("webhook-1", event);
      deadLetterQueue.push("webhook-2", event);

      deadLetterQueue.clear("webhook-1");

      expect(deadLetterQueue.list("webhook-1")).toHaveLength(0);
      expect(deadLetterQueue.list("webhook-2")).toHaveLength(1);
    });
  });

  describe("DeadLetterQueue.getStats", () => {
    it("returns stats", () => {
      const event = {
        eventType: "invoice.paid",
        payload: '{"id":"123"}',
        attemptCount: 3,
      };

      deadLetterQueue.push("webhook-1", event);
      deadLetterQueue.push("webhook-1", event);
      deadLetterQueue.push("webhook-2", event);

      const stats = deadLetterQueue.getStats();

      expect(stats.totalWebhooks).toBe(2);
      expect(stats.totalEvents).toBe(3);
    });

    it("returns zero stats when empty", () => {
      const stats = deadLetterQueue.getStats();

      expect(stats.totalWebhooks).toBe(0);
      expect(stats.totalEvents).toBe(0);
    });
  });

  describe("pushToDeadLetter", () => {
    it("pushes delivery to dead letter queue", () => {
      const delivery = {
        eventType: "invoice.paid",
        payload: '{"id":"123"}',
        lastError: "Timeout",
        attemptCount: 3,
        lastStatusCode: 504,
      };

      pushToDeadLetter("webhook-1", delivery);

      const list = deadLetterQueue.list("webhook-1");
      expect(list).toHaveLength(1);
      expect(list[0].eventType).toBe("invoice.paid");
      expect(list[0].lastError).toBe("Timeout");
    });
  });

  describe("complexity", () => {
    it("push: O(1) insertion", () => {
      const event = {
        eventType: "invoice.paid",
        payload: '{"id":"123"}',
        attemptCount: 3,
      };

      const start = performance.now();
      for (let i = 0; i < 10000; i++) {
        deadLetterQueue.push(`webhook-${i % 100}`, event);
      }
      const duration = performance.now() - start;

      // Should be fast (< 100ms for 10k insertions)
      expect(duration).toBeLessThan(100);
    });

    it("list: O(1) retrieval", () => {
      const event = {
        eventType: "invoice.paid",
        payload: '{"id":"123"}',
        attemptCount: 3,
      };

      // Set up many webhooks
      for (let i = 0; i < 1000; i++) {
        deadLetterQueue.push(`webhook-${i}`, event);
      }

      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        deadLetterQueue.list(`webhook-${i}`);
      }
      const duration = performance.now() - start;

      // Should be fast (< 10ms for 1000 lookups)
      expect(duration).toBeLessThan(10);
    });
  });
});
