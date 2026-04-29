type InvoicePaidPayload = { userId: string; invoiceId: string }
type InvoicePaidListener = (payload: InvoicePaidPayload) => void

const invoicePaidListeners: InvoicePaidListener[] = []

export function onInvoicePaid(listener: InvoicePaidListener): void {
  invoicePaidListeners.push(listener)
}

export function emitInvoicePaid(payload: InvoicePaidPayload): void {
  for (const listener of invoicePaidListeners) {
    listener(payload)
  }
}
