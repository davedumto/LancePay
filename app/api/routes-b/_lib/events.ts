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