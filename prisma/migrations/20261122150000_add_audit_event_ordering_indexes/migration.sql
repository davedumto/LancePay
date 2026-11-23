-- Audit events are read per invoice in createdAt order. The invoice-only index
-- forces a sort on busy invoices, so it is replaced by a composite index that
-- satisfies both the filter and the ordering.
DROP INDEX IF EXISTS "AuditEvent_invoiceId_idx";
CREATE INDEX "AuditEvent_invoiceId_createdAt_idx" ON "AuditEvent"("invoiceId", "createdAt");

-- The admin activity timeline filters audit events by actorId.
CREATE INDEX "AuditEvent_actorId_idx" ON "AuditEvent"("actorId");
