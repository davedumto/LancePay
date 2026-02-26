-- Invoice: composite index for the most common dashboard/list query
CREATE INDEX "Invoice_userId_status_createdAt_idx" ON "Invoice"("userId", "status", "createdAt" DESC);

-- Invoice: composite index for tax reports and revenue analytics
CREATE INDEX "Invoice_userId_paidAt_idx" ON "Invoice"("userId", "paidAt" DESC);

-- Invoice: composite index for client verification and payment history lookups
CREATE INDEX "Invoice_clientEmail_status_idx" ON "Invoice"("clientEmail", "status");

-- Invoice: single-column index for overdue detection cron jobs
CREATE INDEX "Invoice_dueDate_idx" ON "Invoice"("dueDate");

-- Invoice: composite index for admin dashboard and platform analytics
CREATE INDEX "Invoice_status_createdAt_idx" ON "Invoice"("status", "createdAt" DESC);

-- Transaction: composite index for per-user activity feeds and dashboards
CREATE INDEX "Transaction_userId_status_createdAt_idx" ON "Transaction"("userId", "status", "createdAt" DESC);

-- Transaction: index to speed up invoice-transaction join lookups
CREATE INDEX "Transaction_invoiceId_idx" ON "Transaction"("invoiceId");

-- Transaction: composite index for type-based filtering with status
CREATE INDEX "Transaction_type_status_idx" ON "Transaction"("type", "status");

-- Dispute: composite index for admin dispute queue ordered by recency
CREATE INDEX "Dispute_status_createdAt_idx" ON "Dispute"("status", "createdAt" DESC);

-- PaymentAdvance: composite index for per-user advance status queries
CREATE INDEX "PaymentAdvance_userId_status_idx" ON "PaymentAdvance"("userId", "status");

-- AuditEvent: composite index for per-invoice audit trail ordered by recency
CREATE INDEX "AuditEvent_invoiceId_createdAt_idx" ON "AuditEvent"("invoiceId", "createdAt" DESC);

-- AuditEvent: index for actor-based audit lookups
CREATE INDEX "AuditEvent_actorId_idx" ON "AuditEvent"("actorId");
