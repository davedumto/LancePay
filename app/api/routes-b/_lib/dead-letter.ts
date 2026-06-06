import { randomUUID } from 'crypto'

interface DeadLetterEvent {
  id: string
  webhookId: string
  eventType: string
  payload: string
  timestamp: Date
  lastError?: string
  attemptCount: number
  lastStatusCode?: number
}

class DeadLetterQueue {
  private queues = new Map<string, DeadLetterEvent[]>()
  private readonly maxEntriesPerWebhook = 1000

  push(webhookId: string, event: Omit<DeadLetterEvent, 'id' | 'timestamp'>): void {
    const queue = this.queues.get(webhookId) || []
    
    // Enforce cap with FIFO eviction
    if (queue.length >= this.maxEntriesPerWebhook) {
      queue.shift() // Remove oldest entry
    }
    
    const deadLetterEvent: DeadLetterEvent = {
      ...event,
      id: randomUUID(),
      timestamp: new Date(),
    }
    
    queue.push(deadLetterEvent)
    this.queues.set(webhookId, queue)
  }

  list(webhookId: string): DeadLetterEvent[] {
    return this.queues.get(webhookId) || []
  }

  replay(webhookId: string, eventId: string): DeadLetterEvent | null {
    const queue = this.queues.get(webhookId)
    if (!queue) return null
    
    const index = queue.findIndex(event => event.id === eventId)
    if (index === -1) return null
    
    const event = queue[index]
    queue.splice(index, 1) // Remove from queue
    
    // Update queue if empty
    if (queue.length === 0) {
      this.queues.delete(webhookId)
    } else {
      this.queues.set(webhookId, queue)
    }
    
    return event
  }

  clear(webhookId: string): void {
    this.queues.delete(webhookId)
  }

  // For testing/debugging
  getStats(): { totalWebhooks: number; totalEvents: number } {
    let totalEvents = 0
    for (const queue of this.queues.values()) {
      totalEvents += queue.length
    }
    return {
      totalWebhooks: this.queues.size,
      totalEvents,
    }
  }
}

// Singleton instance
export const deadLetterQueue = new DeadLetterQueue()

// Helper functions for webhook delivery integration
export function shouldDeadLetter(status: string, attemptCount: number): boolean {
  return status === 'failed' && attemptCount >= 3 // Max retries
}

export function pushToDeadLetter(webhookId: string, delivery: {
  eventType: string
  payload: string
  lastError?: string
  attemptCount: number
  lastStatusCode?: number
}): void {
  deadLetterQueue.push(webhookId, {
    webhookId,
    eventType: delivery.eventType,
    payload: delivery.payload,
    lastError: delivery.lastError,
    attemptCount: delivery.attemptCount,
    lastStatusCode: delivery.lastStatusCode,
  })
}
