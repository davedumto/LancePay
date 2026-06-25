export type WebhookEventDefinition = {
  type: string
  category: string
  description: string
}

export const WEBHOOK_EVENT_CATALOG: WebhookEventDefinition[] = [
  { type: 'invoice.created', category: 'invoice', description: 'A new invoice was created.' },
  { type: 'invoice.paid', category: 'invoice', description: 'An invoice was marked as paid.' },
  { type: 'invoice.overdue', category: 'invoice', description: 'An invoice became overdue.' },
  { type: 'invoice.cancelled', category: 'invoice', description: 'An invoice was cancelled.' },
  { type: 'transfer.completed', category: 'transfer', description: 'A transfer completed successfully.' },
  { type: 'transfer.failed', category: 'transfer', description: 'A transfer failed.' },
  { type: 'withdrawal.completed', category: 'withdrawal', description: 'A withdrawal completed successfully.' },
  { type: 'withdrawal.failed', category: 'withdrawal', description: 'A withdrawal failed.' },
  { type: 'kyc.submitted', category: 'kyc', description: 'A KYC application was submitted.' },
  { type: 'kyc.approved', category: 'kyc', description: 'A KYC application was approved.' },
  { type: 'kyc.rejected', category: 'kyc', description: 'A KYC application was rejected.' },
  { type: 'api_key.created', category: 'api_key', description: 'An API key was created.' },
  { type: 'reconciliation.matched', category: 'reconciliation', description: 'A transaction was matched to an invoice.' },
]
