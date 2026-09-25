# Account deletion and saved filters

This note covers the account deletion request lifecycle (`/api/account-deletion-requests`) and saved invoice filters (`/api/saved-filters`). All endpoints require a Privy bearer token and only ever read or write the caller's own rows.

## Account deletion requests

### Lifecycle

`AccountDeletionRequest` is unique per user (`@@unique([userId])`). Its `status` moves `pending` → `cancelled` | `completed`.

- `POST` creates the row as `pending` with `scheduledAt = now + 30 days` (`ACCOUNT_DELETION_GRACE_DAYS` in `lib/account-deletion.ts`). If the user's previous request was cancelled, the same row is re-opened with a fresh grace period.
- A request is cancellable only while it is `pending` and `scheduledAt` is still in the future.
- Whatever executes deletions must claim a row with a conditional update on `status = 'pending' AND scheduledAt <= now()` and move it out of `pending` before doing any work. Cancellation uses the mirror condition (`status = 'pending' AND scheduledAt > now`), so a cancel and a claim can never both succeed.

### `GET /api/account-deletion-requests`

Returns `{ deletionRequest }`, or `null` if none exists. The request includes `cancellable` and `remainingGraceSeconds`.

### `POST /api/account-deletion-requests`

Body (optional): `{ "reason"?: string (≤ 500 chars) }`.

The request is rejected with `409` and a `blockers` list while any of these exist:

| Blocker | Rows counted |
|---|---|
| `unpaid_invoices` | `Invoice` where the user is the issuer (`userId`) or the client (`clientId`) and `status` is `pending` or `overdue` |
| `active_disputes` | `Dispute` on one of those invoices whose `status` is not `resolved`/`closed` and `resolvedAt` is null |
| `pending_payouts` | `PayoutBatch` in `pending`/`processing`, plus `WithdrawalTransaction` in `pending`/`interactive`/`submitted` |

On success (`202`) the response carries `deletionRequest`, `graceDays`, and `dataExport: { offered: true, availableUntil }`. In the same transaction an in-app `Notification` of type `account_deletion_data_export` is created, telling the user they can export their data until `scheduledAt`. An email with the same offer is sent after commit (fire-and-forget).

A second request while one is `pending` returns `409` with the existing request.

### `DELETE /api/account-deletion-requests/[id]`

Cancels the caller's pending request. Returns `404` for a missing request or one owned by someone else. Returns `409` when the request is already cancelled, has left `pending`, the grace period has elapsed, or its state changed between the read and the update. On success returns `{ deletionRequest, remainingGraceSeconds, graceEndsAt }`.

## Saved invoice filters

### Definition format

Filters are stored in `SavedFilter.filters` (JSON) with `entityType = 'invoice'`:

```json
{
  "match": "all",
  "conditions": [
    { "field": "status", "operator": "in", "value": ["pending", "overdue"] },
    { "field": "amount", "operator": "gte", "value": 500 },
    { "field": "dueDate", "operator": "lt", "value": "2026-10-01" }
  ]
}
```

- `match` is `all` (AND) or `any` (OR), default `all`.
- 1–20 conditions. Unknown properties anywhere in the definition are rejected.

| Field | Type | Operators |
|---|---|---|
| `status`, `currency`, `escrowStatus` | keyword | `eq`, `neq`, `in`, `notIn` |
| `invoiceNumber`, `clientEmail`, `description` | text | `eq`, `neq`, `contains`, `startsWith`, `endsWith` (case-insensitive) |
| `clientName` | text, nullable | text operators, `isNull`, `isNotNull` |
| `amount` | number | `eq`, `neq`, `gt`, `gte`, `lt`, `lte` |
| `createdAt` | date | `gt`, `gte`, `lt`, `lte` |
| `dueDate`, `paidAt` | date, nullable | date operators, `isNull`, `isNotNull` |
| `escrowEnabled` | boolean | `eq` |

Values must match the field type: strings of 1–255 characters, `in`/`notIn` arrays of 1–50 strings, finite JSON numbers (not numeric strings), ISO 8601 dates or date-times, and JSON booleans. `isNull`/`isNotNull` take no value.

### Safety model

`lib/saved-filters.ts` validates definitions against the allowlists above and translates each condition into a fixed Prisma filter shape. Field names are looked up with an own-property check (so `__proto__`, `constructor`, etc. are rejected), operators map through an explicit switch, and values are passed to Prisma as bound parameters. No raw SQL is built. The owner scope `{ userId }` wraps the translated conditions in an outer `AND`, so `any` filters cannot widen results past the caller's own invoices.

Stored definitions are re-validated every time they run. A row that no longer validates (hand edits, older formats) returns `422` and is never executed.

### `GET /api/saved-filters?page=&pageSize=`

Lists the caller's invoice filters, newest first. `pageSize` defaults to 25 and is clamped to 100.

### `POST /api/saved-filters`

Body: `{ "name": string (1–100 chars, trimmed), "definition": <definition> }`. Returns `201` with the saved filter. Invalid definitions return `400` with per-condition `details`. Names are unique per user through the `@@unique([userId, name])` constraint, and a duplicate returns `409`. Different users can use the same name.

### `POST /api/saved-filters/[id]/execute?page=&pageSize=`

Runs one of the caller's filters. The filter is looked up by `id` and `userId` together, so another user's filter returns the same `404` as a missing one. Results are the caller's own invoices (`Invoice.userId`, matching `GET /api/invoices`), ordered by `createdAt desc, id desc`, and paginated in the database (`pageSize` default 25, max 100). Response: `{ savedFilter, invoices, pagination: { page, pageSize, totalRows, totalPages } }`.
