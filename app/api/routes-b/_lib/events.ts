type InvoicePaidPayload = {
  userId: string;
  invoiceId: string;
};

type InvoicePaidListener = (payload: InvoicePaidPayload) => void;

const invoicePaidListeners = new Set<InvoicePaidListener>();

/**
 * Subscribes to invoice paid events.
 * Returns an unsubscribe function.
 */
export function onInvoicePaid(listener: InvoicePaidListener): () => void {
  invoicePaidListeners.add(listener);

  return () => {
    invoicePaidListeners.delete(listener);
  };
}

/**
 * Emits an invoice paid event to all listeners.
 */
export function emitInvoicePaid(payload: InvoicePaidPayload): void {
  // Create a snapshot to avoid mutation issues during iteration
  const listeners = Array.from(invoicePaidListeners);

  for (const listener of listeners) {
    try {
      listener(payload);
    } catch (err) {
      // Prevent one bad listener from breaking the entire chain
      console.error("InvoicePaid listener error:", err);
    }
  }
}

type StatsInvalidatedPayload = {
  userId: string;
};

type StatsInvalidatedListener = (payload: StatsInvalidatedPayload) => void;

const statsInvalidatedListeners = new Set<StatsInvalidatedListener>();

/**
 * Subscribes to stats cache invalidation events.
 * Returns an unsubscribe function.
 */
export function onStatsInvalidated(listener: StatsInvalidatedListener): () => void {
  statsInvalidatedListeners.add(listener);

  return () => {
    statsInvalidatedListeners.delete(listener);
  };
}

/**
 * Emits a stats cache invalidation event to all listeners.
 */
export function emitStatsInvalidated(payload: StatsInvalidatedPayload): void {
  const listeners = Array.from(statsInvalidatedListeners);

  for (const listener of listeners) {
    try {
      listener(payload);
    } catch (err) {
      console.error("StatsInvalidated listener error:", err);
    }
  }
}