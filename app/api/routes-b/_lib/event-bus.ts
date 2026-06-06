/**
 * In-process pub/sub event bus for routes-b notifications.
 *
 * Provides real-time event delivery with capacity-bounded queues per subscriber.
 * Slow consumers are dropped without affecting others.
 * Connections are capped per user to prevent resource exhaustion.
 */

export interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
}

export interface EventBusEvent {
  type: "notification";
  data: Notification;
  timestamp: number;
}

type EventHandler = (event: EventBusEvent) => void;

interface Subscriber {
  id: string;
  userId: string;
  handler: EventHandler;
  queue: EventBusEvent[];
  maxQueueSize: number;
  isActive: boolean;
  createdAt: number;
}

// Global state
const subscribers = new Map<string, Subscriber>();
const userConnections = new Map<string, Set<string>>();

const DEFAULT_MAX_QUEUE_SIZE = 100;
const MAX_CONNECTIONS_PER_USER = 5;
const QUEUE_OVERFLOW_THRESHOLD = 0.9; // Drop subscriber if queue is 90% full

/**
 * Subscribe to events with a handler function.
 * Returns a subscription ID that can be used to unsubscribe.
 *
 * @param userId - The user ID to subscribe for
 * @param handler - Callback function to handle events
 * @returns Subscription ID, or null if max connections exceeded
 */
export function subscribe(
  userId: string,
  handler: EventHandler,
): string | null {
  // Check connection limit
  const userSubs = userConnections.get(userId) ?? new Set();
  if (userSubs.size >= MAX_CONNECTIONS_PER_USER) {
    return null;
  }

  const subscriptionId = `sub_${userId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const subscriber: Subscriber = {
    id: subscriptionId,
    userId,
    handler,
    queue: [],
    maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
    isActive: true,
    createdAt: Date.now(),
  };

  subscribers.set(subscriptionId, subscriber);

  if (!userConnections.has(userId)) {
    userConnections.set(userId, new Set());
  }
  userConnections.get(userId)!.add(subscriptionId);

  return subscriptionId;
}

/**
 * Unsubscribe from events.
 *
 * @param subscriptionId - The subscription ID returned from subscribe()
 */
export function unsubscribe(subscriptionId: string): void {
  const subscriber = subscribers.get(subscriptionId);
  if (!subscriber) return;

  subscribers.delete(subscriptionId);

  const userSubs = userConnections.get(subscriber.userId);
  if (userSubs) {
    userSubs.delete(subscriptionId);
    if (userSubs.size === 0) {
      userConnections.delete(subscriber.userId);
    }
  }
}

/**
 * Publish an event to all subscribers for a user.
 * Slow consumers (queue overflow) are automatically dropped.
 *
 * @param userId - The user ID to publish to
 * @param event - The event to publish
 */
export function publish(userId: string, event: EventBusEvent): void {
  const userSubs = userConnections.get(userId);
  if (!userSubs || userSubs.size === 0) return;

  const toRemove: string[] = [];

  for (const subscriptionId of userSubs) {
    const subscriber = subscribers.get(subscriptionId);
    if (!subscriber || !subscriber.isActive) {
      toRemove.push(subscriptionId);
      continue;
    }

    // Check if queue is overflowing
    if (
      subscriber.queue.length >=
      subscriber.maxQueueSize * QUEUE_OVERFLOW_THRESHOLD
    ) {
      // Drop slow consumer
      toRemove.push(subscriptionId);
      continue;
    }

    subscriber.queue.push(event);

    // Try to deliver immediately
    try {
      deliverNextEvent(subscriber);
    } catch (error) {
      // Handler threw, mark as inactive
      subscriber.isActive = false;
      toRemove.push(subscriptionId);
    }
  }

  // Clean up inactive subscribers
  for (const subscriptionId of toRemove) {
    unsubscribe(subscriptionId);
  }
}

/**
 * Deliver the next event in the queue to the subscriber.
 * Returns true if an event was delivered, false if queue is empty.
 */
function deliverNextEvent(subscriber: Subscriber): boolean {
  if (subscriber.queue.length === 0) return false;

  const event = subscriber.queue.shift()!;
  subscriber.handler(event);
  return true;
}

/**
 * Get the next event for a subscriber, waiting up to timeout ms.
 * Used by SSE handlers to get events to send to clients.
 *
 * @param subscriptionId - The subscription ID
 * @param timeoutMs - How long to wait for an event (default 30000ms)
 * @returns The next event, or null if timeout
 */
export async function waitForEvent(
  subscriptionId: string,
  timeoutMs = 30000,
): Promise<EventBusEvent | null> {
  const subscriber = subscribers.get(subscriptionId);
  if (!subscriber) return null;

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    // Check if there's an event in the queue
    if (subscriber.queue.length > 0) {
      return subscriber.queue.shift()!;
    }

    // Wait a bit before checking again
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return null;
}

/**
 * Get the current queue size for a subscriber.
 * Useful for monitoring.
 */
export function getQueueSize(subscriptionId: string): number {
  return subscribers.get(subscriptionId)?.queue.length ?? 0;
}

/**
 * Get the number of active subscribers for a user.
 */
export function getSubscriberCount(userId: string): number {
  return userConnections.get(userId)?.size ?? 0;
}

/**
 * Get all active subscriptions (for testing/debugging).
 */
export function getAllSubscriptions(): Subscriber[] {
  return Array.from(subscribers.values());
}

/**
 * Clear all subscriptions (for testing).
 */
export function clearAllSubscriptions(): void {
  subscribers.clear();
  userConnections.clear();
}

/**
 * Mark a subscriber as inactive (for testing/cleanup).
 */
export function markInactive(subscriptionId: string): void {
  const subscriber = subscribers.get(subscriptionId);
  if (subscriber) {
    subscriber.isActive = false;
  }
}

/**
 * Get subscriber info (for testing/debugging).
 */
export function getSubscriber(subscriptionId: string): Subscriber | undefined {
  return subscribers.get(subscriptionId);
}
