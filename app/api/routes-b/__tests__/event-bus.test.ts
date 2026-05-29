import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  subscribe,
  unsubscribe,
  publish,
  waitForEvent,
  getQueueSize,
  getSubscriberCount,
  getAllSubscriptions,
  clearAllSubscriptions,
  markInactive,
  getSubscriber,
  type EventBusEvent,
} from "../_lib/event-bus";

describe("event-bus", () => {
  beforeEach(() => {
    clearAllSubscriptions();
  });

  afterEach(() => {
    clearAllSubscriptions();
  });

  describe("subscribe", () => {
    it("creates a subscription and returns subscription ID", () => {
      const handler = vi.fn();
      const subId = subscribe("user-1", handler);

      expect(subId).toBeDefined();
      expect(subId).toMatch(/^sub_user-1_/);
    });

    it("tracks subscriber count per user", () => {
      const handler = vi.fn();
      subscribe("user-1", handler);
      subscribe("user-1", handler);

      expect(getSubscriberCount("user-1")).toBe(2);
    });

    it("enforces max connections per user (5)", () => {
      const handler = vi.fn();

      // Subscribe 5 times
      for (let i = 0; i < 5; i++) {
        const subId = subscribe("user-1", handler);
        expect(subId).not.toBeNull();
      }

      // 6th subscription should fail
      const sixthSub = subscribe("user-1", handler);
      expect(sixthSub).toBeNull();
    });

    it("allows different users to have independent connections", () => {
      const handler = vi.fn();

      for (let i = 0; i < 5; i++) {
        subscribe("user-1", handler);
        subscribe("user-2", handler);
      }

      expect(getSubscriberCount("user-1")).toBe(5);
      expect(getSubscriberCount("user-2")).toBe(5);

      // Both users can't add more
      expect(subscribe("user-1", handler)).toBeNull();
      expect(subscribe("user-2", handler)).toBeNull();
    });
  });

  describe("unsubscribe", () => {
    it("removes a subscription", () => {
      const handler = vi.fn();
      const subId = subscribe("user-1", handler)!;

      expect(getSubscriberCount("user-1")).toBe(1);

      unsubscribe(subId);

      expect(getSubscriberCount("user-1")).toBe(0);
    });

    it("handles unsubscribing non-existent subscription", () => {
      expect(() => unsubscribe("non-existent")).not.toThrow();
    });

    it("cleans up user entry when last subscription is removed", () => {
      const handler = vi.fn();
      const subId = subscribe("user-1", handler)!;

      unsubscribe(subId);

      expect(getSubscriberCount("user-1")).toBe(0);
    });
  });

  describe("publish", () => {
    it("publishes event to subscriber queue", () => {
      const handler = vi.fn();
      const subId = subscribe("user-1", handler)!;

      const event: EventBusEvent = {
        type: "notification",
        data: {
          id: "n1",
          type: "invoice_paid",
          title: "Invoice Paid",
          message: "Your invoice has been paid",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
        timestamp: Date.now(),
      };

      publish("user-1", event);

      expect(getQueueSize(subId)).toBe(1);
    });

    it("publishes to all subscribers of a user", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const subId1 = subscribe("user-1", handler1)!;
      const subId2 = subscribe("user-1", handler2)!;

      const event: EventBusEvent = {
        type: "notification",
        data: {
          id: "n1",
          type: "invoice_paid",
          title: "Invoice Paid",
          message: "Your invoice has been paid",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
        timestamp: Date.now(),
      };

      publish("user-1", event);

      expect(getQueueSize(subId1)).toBe(1);
      expect(getQueueSize(subId2)).toBe(1);
    });

    it("does not publish to other users", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const subId1 = subscribe("user-1", handler1)!;
      const subId2 = subscribe("user-2", handler2)!;

      const event: EventBusEvent = {
        type: "notification",
        data: {
          id: "n1",
          type: "invoice_paid",
          title: "Invoice Paid",
          message: "Your invoice has been paid",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
        timestamp: Date.now(),
      };

      publish("user-1", event);

      expect(getQueueSize(subId1)).toBe(1);
      expect(getQueueSize(subId2)).toBe(0);
    });

    it("ignores publish to non-existent user", () => {
      const event: EventBusEvent = {
        type: "notification",
        data: {
          id: "n1",
          type: "invoice_paid",
          title: "Invoice Paid",
          message: "Your invoice has been paid",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
        timestamp: Date.now(),
      };

      expect(() => publish("non-existent-user", event)).not.toThrow();
    });

    it("drops slow consumers (queue overflow)", () => {
      const handler = vi.fn();
      const subId = subscribe("user-1", handler)!;

      // Fill queue to near capacity (100 items)
      for (let i = 0; i < 95; i++) {
        const event: EventBusEvent = {
          type: "notification",
          data: {
            id: `n${i}`,
            type: "invoice_paid",
            title: "Invoice Paid",
            message: "Your invoice has been paid",
            isRead: false,
            createdAt: new Date().toISOString(),
          },
          timestamp: Date.now(),
        };
        publish("user-1", event);
      }

      expect(getQueueSize(subId)).toBe(95);

      // Next publish should drop the slow consumer (queue at 95% capacity)
      const event: EventBusEvent = {
        type: "notification",
        data: {
          id: "n96",
          type: "invoice_paid",
          title: "Invoice Paid",
          message: "Your invoice has been paid",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
        timestamp: Date.now(),
      };
      publish("user-1", event);

      // Subscriber should be removed
      expect(getSubscriber(subId)).toBeUndefined();
      expect(getSubscriberCount("user-1")).toBe(0);
    });

    it("does not affect other subscribers when one is dropped", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const subId1 = subscribe("user-1", handler1)!;
      const subId2 = subscribe("user-1", handler2)!;

      // Fill first subscriber's queue
      for (let i = 0; i < 95; i++) {
        const event: EventBusEvent = {
          type: "notification",
          data: {
            id: `n${i}`,
            type: "invoice_paid",
            title: "Invoice Paid",
            message: "Your invoice has been paid",
            isRead: false,
            createdAt: new Date().toISOString(),
          },
          timestamp: Date.now(),
        };
        publish("user-1", event);
      }

      // Drop first subscriber
      const event: EventBusEvent = {
        type: "notification",
        data: {
          id: "n96",
          type: "invoice_paid",
          title: "Invoice Paid",
          message: "Your invoice has been paid",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
        timestamp: Date.now(),
      };
      publish("user-1", event);

      // First subscriber should be gone
      expect(getSubscriber(subId1)).toBeUndefined();

      // Second subscriber should still be active and receive the event
      expect(getSubscriber(subId2)).toBeDefined();
      expect(getQueueSize(subId2)).toBe(1);
    });
  });

  describe("waitForEvent", () => {
    it("returns event immediately if queue has events", async () => {
      const handler = vi.fn();
      const subId = subscribe("user-1", handler)!;

      const event: EventBusEvent = {
        type: "notification",
        data: {
          id: "n1",
          type: "invoice_paid",
          title: "Invoice Paid",
          message: "Your invoice has been paid",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
        timestamp: Date.now(),
      };

      publish("user-1", event);

      const result = await waitForEvent(subId, 1000);

      expect(result).toEqual(event);
    });

    it("waits for event if queue is empty", async () => {
      const handler = vi.fn();
      const subId = subscribe("user-1", handler)!;

      // Publish event after a delay
      setTimeout(() => {
        const event: EventBusEvent = {
          type: "notification",
          data: {
            id: "n1",
            type: "invoice_paid",
            title: "Invoice Paid",
            message: "Your invoice has been paid",
            isRead: false,
            createdAt: new Date().toISOString(),
          },
          timestamp: Date.now(),
        };
        publish("user-1", event);
      }, 100);

      const result = await waitForEvent(subId, 1000);

      expect(result).toBeDefined();
      expect(result?.data.id).toBe("n1");
    });

    it("returns null on timeout", async () => {
      const handler = vi.fn();
      const subId = subscribe("user-1", handler)!;

      const result = await waitForEvent(subId, 100);

      expect(result).toBeNull();
    });

    it("returns null for non-existent subscription", async () => {
      const result = await waitForEvent("non-existent", 100);

      expect(result).toBeNull();
    });

    it("dequeues event when returned", async () => {
      const handler = vi.fn();
      const subId = subscribe("user-1", handler)!;

      const event: EventBusEvent = {
        type: "notification",
        data: {
          id: "n1",
          type: "invoice_paid",
          title: "Invoice Paid",
          message: "Your invoice has been paid",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
        timestamp: Date.now(),
      };

      publish("user-1", event);
      expect(getQueueSize(subId)).toBe(1);

      await waitForEvent(subId, 1000);

      expect(getQueueSize(subId)).toBe(0);
    });
  });

  describe("getQueueSize", () => {
    it("returns 0 for non-existent subscription", () => {
      expect(getQueueSize("non-existent")).toBe(0);
    });

    it("returns queue size", () => {
      const handler = vi.fn();
      const subId = subscribe("user-1", handler)!;

      for (let i = 0; i < 5; i++) {
        const event: EventBusEvent = {
          type: "notification",
          data: {
            id: `n${i}`,
            type: "invoice_paid",
            title: "Invoice Paid",
            message: "Your invoice has been paid",
            isRead: false,
            createdAt: new Date().toISOString(),
          },
          timestamp: Date.now(),
        };
        publish("user-1", event);
      }

      expect(getQueueSize(subId)).toBe(5);
    });
  });

  describe("getSubscriberCount", () => {
    it("returns 0 for non-existent user", () => {
      expect(getSubscriberCount("non-existent")).toBe(0);
    });

    it("returns subscriber count", () => {
      const handler = vi.fn();

      subscribe("user-1", handler);
      subscribe("user-1", handler);
      subscribe("user-1", handler);

      expect(getSubscriberCount("user-1")).toBe(3);
    });
  });

  describe("getAllSubscriptions", () => {
    it("returns all subscriptions", () => {
      const handler = vi.fn();

      subscribe("user-1", handler);
      subscribe("user-1", handler);
      subscribe("user-2", handler);

      const all = getAllSubscriptions();

      expect(all).toHaveLength(3);
    });

    it("returns empty array when no subscriptions", () => {
      const all = getAllSubscriptions();

      expect(all).toEqual([]);
    });
  });

  describe("markInactive", () => {
    it("marks subscriber as inactive", () => {
      const handler = vi.fn();
      const subId = subscribe("user-1", handler)!;

      const subscriber = getSubscriber(subId);
      expect(subscriber?.isActive).toBe(true);

      markInactive(subId);

      const updated = getSubscriber(subId);
      expect(updated?.isActive).toBe(false);
    });

    it("handles non-existent subscription", () => {
      expect(() => markInactive("non-existent")).not.toThrow();
    });
  });

  describe("real-world scenarios", () => {
    it("handles multiple users with multiple subscribers each", () => {
      const handler = vi.fn();

      const user1Subs = [
        subscribe("user-1", handler),
        subscribe("user-1", handler),
        subscribe("user-1", handler),
      ];

      const user2Subs = [
        subscribe("user-2", handler),
        subscribe("user-2", handler),
      ];

      expect(getSubscriberCount("user-1")).toBe(3);
      expect(getSubscriberCount("user-2")).toBe(2);

      // Publish to user-1
      const event: EventBusEvent = {
        type: "notification",
        data: {
          id: "n1",
          type: "invoice_paid",
          title: "Invoice Paid",
          message: "Your invoice has been paid",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
        timestamp: Date.now(),
      };

      publish("user-1", event);

      // All user-1 subscribers should have the event
      for (const subId of user1Subs) {
        expect(getQueueSize(subId)).toBe(1);
      }

      // User-2 subscribers should not have it
      for (const subId of user2Subs) {
        expect(getQueueSize(subId)).toBe(0);
      }
    });

    it("handles rapid publish/consume cycle", async () => {
      const handler = vi.fn();
      const subId = subscribe("user-1", handler)!;

      for (let i = 0; i < 10; i++) {
        const event: EventBusEvent = {
          type: "notification",
          data: {
            id: `n${i}`,
            type: "invoice_paid",
            title: "Invoice Paid",
            message: "Your invoice has been paid",
            isRead: false,
            createdAt: new Date().toISOString(),
          },
          timestamp: Date.now(),
        };

        publish("user-1", event);

        const received = await waitForEvent(subId, 1000);
        expect(received?.data.id).toBe(`n${i}`);
      }

      expect(getQueueSize(subId)).toBe(0);
    });

    it("handles subscriber cleanup on unsubscribe", () => {
      const handler = vi.fn();
      const subIds = [
        subscribe("user-1", handler),
        subscribe("user-1", handler),
        subscribe("user-1", handler),
      ];

      expect(getSubscriberCount("user-1")).toBe(3);

      unsubscribe(subIds[0]!);
      expect(getSubscriberCount("user-1")).toBe(2);

      unsubscribe(subIds[1]!);
      expect(getSubscriberCount("user-1")).toBe(1);

      unsubscribe(subIds[2]!);
      expect(getSubscriberCount("user-1")).toBe(0);
    });
  });
});
