type InvoicePaidListener = (payload: {
  userId: string;
  invoiceId: string;
}) => void;

const invoicePaidListeners = new Set<InvoicePaidListener>();

export function onInvoicePaid(listener: InvoicePaidListener) {
  invoicePaidListeners.add(listener);
  return () => invoicePaidListeners.delete(listener);
}

export function emitInvoicePaid(payload: {
  userId: string;
  invoiceId: string;
}) {
  for (const listener of invoicePaidListeners) {
    listener(payload);
  }
}
