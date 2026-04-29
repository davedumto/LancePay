# New Features in Routes-B

This document describes the new features added to the routes-b API.

## 1. Feature Flags (`_lib/flags.ts`)

A feature flag system that allows rolling out new features gradually.

### Usage

```typescript
import { isEnabled, clearFlagCache } from './_lib/flags'

// In a route handler
export async function GET(request: NextRequest) {
  // Check if feature is enabled for user
  if (!isEnabled('bulk-contacts-import', { userId: user.id })) {
    return NextResponse.json(
      { error: 'Feature not available' },
      { status: 403 }
    )
  }
  
  // Your feature code here
}
```

### Configuration

Flags can be controlled via environment variables:

```bash
# Enable for all users
FLAG_BULK_CONTACTS_IMPORT=on

# Disable for all users  
FLAG_BULK_CONTACTS_IMPORT=off

# Enable for specific users only
FLAG_BULK_CONTACTS_IMPORT=user1,user2,user3
```

### Default Flags

- `bulk-contacts-import`: off
- `presigned-uploads`: off  
- `sparkline-charts`: off
- `webhook-event-filtering`: off

## 2. OpenAPI Documentation (`_lib/openapi.ts`)

Automatic OpenAPI 3.1 documentation generation.

### Usage

```typescript
import { registerRoute } from './_lib/openapi'
import { z } from 'zod'

// Register your route
registerRoute({
  method: 'GET',
  path: '/stats',
  summary: 'Get user statistics',
  description: 'Returns invoice statistics...',
  requestSchema: z.object({ /* Zod schema */ }),
  responseSchema: z.object({ /* Zod schema */ }),
  tags: ['stats']
})
```

### Access Documentation

```
GET /api/routes-b/_openapi
```

Returns a complete OpenAPI 3.1 document with all registered routes.

## 3. Bulk CSV Import (`/contacts/import`)

Import contacts from CSV files.

### Endpoint

```
POST /api/routes-b/contacts/import
Content-Type: text/csv
```

### CSV Format

Required column: `name`
Optional columns: `email`, `phone`, `company`, `tags`

Example:
```csv
name,email,phone,company,tags
John Doe,john@example.com,1234567890,Acme Inc,client;vip
Jane Smith,jane@example.com,,,freelancer
```

### Response

```json
{
  "results": [
    {
      "row": 1,
      "ok": true,
      "contactId": "contact_123"
    },
    {
      "row": 2, 
      "ok": false,
      "error": "Validation failed"
    }
  ],
  "summary": {
    "total": 2,
    "imported": 1,
    "skipped": 0,
    "failed": 1
  }
}
```

### Limits
- Max file size: 2 MiB
- Max rows: 10,000
- Required column: `name`

## 4. Webhook Event Filtering

Webhooks can now filter which events they receive.

### Event Types

Valid event types:
- `invoice.created`, `invoice.paid`, `invoice.cancelled`
- `withdrawal.completed`, `withdrawal.failed`
- `contact.created`, `contact.updated`
- `bank_account.added`, `bank_account.verified`
- `transaction.created`, `transaction.completed`, `transaction.failed`
- `*` (wildcard for all events)

### Usage

```json
// Create webhook with specific events
{
  "targetUrl": "https://example.com/webhook",
  "eventTypes": ["invoice.paid", "withdrawal.completed"]
}

// Update webhook events
PATCH /api/routes-b/webhooks/{id}
{
  "eventTypes": ["invoice.created", "invoice.paid"]
}
```

### Backwards Compatibility

Existing webhooks default to `["*"]` (all events).

## Testing

All features include comprehensive tests in `app/api/routes-b/__tests__/`:

- `flags.test.ts` - Feature flag tests
- `openapi.test.ts` - OpenAPI registry tests  
- `contacts-import.test.ts` - CSV import tests
- `webhook-events.test.ts` - Webhook event filtering tests

Run tests with:
```bash
npx vitest run app/api/routes-b/__tests__/
```