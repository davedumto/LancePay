# Offline Bank Transfer Verification - Implementation Plan

## Overview
Enable local Nigerian clients without crypto/cards to pay invoices via bank transfer with manual verification. Clients upload proof-of-payment, freelancers verify receipt of funds, system credits USDC to freelancer's wallet.

---

## Architecture Summary

### User Flow
1. **Client**: Views invoice → Selects "Bank Transfer" → Uploads receipt (screenshot/PDF)
2. **System**: Stores receipt locally → Creates `manual_payments` record (status: pending) → Emails freelancer
3. **Freelancer**: Reviews receipt → Confirms/Rejects
4. **On Confirm**: Convert NGN→USDC → Credit wallet via Stellar → Mark invoice paid

### Key Integration Points
- **Stellar Network**: Credit USDC using funding wallet via `sendUSDCPayment()`
- **Exchange Rate**: Convert NGN→USD using `getUsdToNgnRate()` (15-min cache, fallback 1600)
- **Email**: Resend notifications (submission → freelancer, verification → client)
- **Audit**: Log payment events using `logAuditEvent()`

---

## Phase 1: Database Schema

### 1.1 Add Prisma Model
**File**: [prisma/schema.prisma](prisma/schema.prisma)

```prisma
model ManualPayment {
  id          String    @id @default(uuid())
  invoiceId   String
  clientName  String    @db.VarChar(100)
  amountPaid  Decimal   @db.Decimal(18, 2)  // NGN amount
  currency    String    @default("NGN") @db.VarChar(10)
  receiptUrl  String    @db.VarChar(512)     // Relative path: /receipts/{invoiceId}/{filename}
  status      String    @default("pending") @db.VarChar(20)  // pending, verified, rejected
  notes       String?   @db.Text
  createdAt   DateTime  @default(now())
  verifiedAt  DateTime?
  verifiedBy  String?   // userId of freelancer who verified

  invoice     Invoice   @relation(fields: [invoiceId], references: [id], onDelete: Cascade)
  verifier    User?     @relation("ManualPaymentVerifier", fields: [verifiedBy], references: [id])

  @@index([invoiceId])
  @@index([status])
  @@index([createdAt])
}
```

**Add to User model**:
```prisma
model User {
  // ... existing fields
  manualPayments ManualPayment[] @relation("ManualPaymentVerifier")
}
```

**Add to Invoice model**:
```prisma
model Invoice {
  // ... existing fields
  manualPayments ManualPayment[]
}
```

### 1.2 Run Migration
```bash
npx prisma migrate dev --name add_manual_payments
npx prisma generate
```

---

## Phase 2: File Storage Infrastructure

### 2.1 Directory Structure
Create local storage:
```
/Users/arowolokehinde/Stellar-wave1/LancePay/uploads/
└── receipts/
    └── {invoiceId}/
        └── {timestamp}_{random}_{sanitized-filename}.{ext}
```

**Security**: Files stored outside `/public/`, served only via authenticated API endpoint.

### 2.2 File Storage Utility
**File**: [lib/file-storage.ts](lib/file-storage.ts) (create new)

```typescript
import { mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'

const UPLOAD_BASE_DIR = path.join(process.cwd(), 'uploads')
const RECEIPTS_DIR = path.join(UPLOAD_BASE_DIR, 'receipts')

const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'
]
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.pdf']
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

export interface FileValidationResult {
  valid: boolean
  error?: string
}

export function validateReceiptFile(file: File): FileValidationResult {
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: 'File too large (max 10MB)' }
  }
  if (file.size === 0) {
    return { valid: false, error: 'File is empty' }
  }
  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    return { valid: false, error: 'Invalid file type. Allowed: JPG, PNG, WEBP, HEIC, PDF' }
  }
  const ext = path.extname(file.name).toLowerCase()
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return { valid: false, error: 'Invalid file extension' }
  }
  return { valid: true }
}

function sanitizeFilename(filename: string): string {
  const clean = filename
    .replace(/[\/\\]/g, '_')
    .replace(/\0/g, '')
    .replace(/\.\./g, '_')
  const ext = path.extname(clean)
  const base = path.basename(clean, ext)
  const safeName = base.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 100)
  return safeName + ext
}

function generateUniqueFilename(originalName: string): string {
  const timestamp = Date.now()
  const randomSuffix = randomBytes(4).toString('hex')
  const ext = path.extname(originalName)
  const basename = path.basename(originalName, ext)
  const sanitized = sanitizeFilename(basename)
  return `${timestamp}_${randomSuffix}_${sanitized}${ext}`
}

export async function storeReceiptFile(
  invoiceId: string,
  file: File
): Promise<string> {
  const invoiceDir = path.join(RECEIPTS_DIR, invoiceId)
  if (!existsSync(invoiceDir)) {
    await mkdir(invoiceDir, { recursive: true })
  }

  const filename = generateUniqueFilename(file.name)
  const filePath = path.join(invoiceDir, filename)

  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  await writeFile(filePath, buffer)

  // Return relative path for database
  return `/receipts/${invoiceId}/${filename}`
}

export function getReceiptAbsolutePath(receiptUrl: string): string | null {
  if (!receiptUrl.startsWith('/receipts/')) return null

  const absolutePath = path.join(UPLOAD_BASE_DIR, receiptUrl.slice(1))
  const normalizedPath = path.normalize(absolutePath)

  // Security: prevent path traversal
  if (!normalizedPath.startsWith(UPLOAD_BASE_DIR)) return null

  return normalizedPath
}
```

**Security Features**:
- Filename sanitization (prevent `../../etc/passwd`)
- MIME type + extension validation
- Size limits
- Path traversal prevention

---

## Phase 3: API Endpoints

### 3.1 Submit Receipt (Public)
**File**: [app/api/routes-d/local/offline-verification/submit/route.ts](app/api/routes-d/local/offline-verification/submit/route.ts) (create new)

**Endpoint**: `POST /api/routes-d/local/offline-verification/submit`

**Auth**: None (public, like `/api/pay/[invoiceId]`)

**Request**: FormData
- `invoiceNumber`: string (required)
- `clientName`: string (required)
- `amountPaid`: string (decimal, required)
- `currency`: string (default "NGN")
- `notes`: string (optional)
- `receipt`: File (required, max 10MB)

**Logic**:
1. Validate file (type, size) using `validateReceiptFile()`
2. Parse FormData, validate with Zod schema
3. Fetch invoice by `invoiceNumber`, verify status is "pending"
4. Check for duplicate submission (same invoice, pending status, within 1 hour) → return 409
5. Store receipt using `storeReceiptFile(invoiceId, file)`
6. Create `ManualPayment` record with status "pending"
7. Send email notification to freelancer via `sendManualPaymentNotification()`
8. Return `{success: true, paymentId, message}`

**Error Handling**:
- Invalid file → 400
- Invoice not found → 404
- Invoice already paid → 400
- Duplicate submission → 409
- File storage failure → 500

---

### 3.2 Verify/Reject Payment (Authenticated)
**File**: [app/api/routes-d/local/offline-verification/verify/route.ts](app/api/routes-d/local/offline-verification/verify/route.ts) (create new)

**Endpoint**: `PATCH /api/routes-d/local/offline-verification/verify`

**Auth**: Required (Privy JWT)

**Request**:
```json
{
  "paymentId": "uuid",
  "action": "confirm" | "reject",
  "notes": "optional string"
}
```

**Logic**:
1. Verify auth token, get user
2. Parse request body, validate with Zod
3. Fetch `ManualPayment` with invoice and user relations
4. Verify ownership: `invoice.userId === user.id` (else 403)
5. Check status is "pending" (else 409 for idempotency)
6. Check invoice status is "pending" (else 400)

**If action = "reject"**:
- Update `ManualPayment`: status = "rejected", verifiedBy, verifiedAt, notes
- Return success

**If action = "confirm"**:
1. Verify freelancer has wallet (else 400)
2. Get exchange rate: `const {rate} = await getUsdToNgnRate()`
3. Convert: `usdcAmount = Math.floor((ngnAmount / rate) * 100) / 100`
4. Get funding wallet: `process.env.STELLAR_FUNDING_WALLET_SECRET`
5. Credit USDC via Stellar:
   ```typescript
   const txHash = await sendUSDCPayment(
     fundingPublicKey,
     fundingSecretKey,
     freelancerWalletAddress,
     usdcAmount.toString()
   )
   ```
6. Atomic DB transaction (`prisma.$transaction`):
   - Update Invoice: status = "paid", paidAt = now
   - Create Transaction: type = "incoming", status = "completed", txHash, amount, ngnAmount, exchangeRate
   - Update ManualPayment: status = "verified", verifiedBy, verifiedAt, notes
7. Post-processing (async, non-blocking):
   - Log audit event: "invoice.paid.manual"
   - Send confirmation email to client
8. Return `{success, transaction: {txHash, usdcAmount, ngnAmount, exchangeRate}}`

**Error Handling**:
- No auth → 401
- Not owner → 403
- Already verified → 409
- Stellar failure → 500 (no DB changes, user can retry)

---

### 3.3 List Manual Payments (Authenticated)
**File**: [app/api/routes-d/local/offline-verification/list/route.ts](app/api/routes-d/local/offline-verification/list/route.ts) (create new)

**Endpoint**: `GET /api/routes-d/local/offline-verification/list?status=pending`

**Auth**: Required

**Query Params**:
- `status`: optional ("pending" | "verified" | "rejected")

**Logic**:
1. Verify auth, get user
2. Query `ManualPayment` where `invoice.userId === user.id`
3. Filter by status if provided
4. Include invoice details (number, client email, expected amount)
5. Order by `createdAt DESC`, limit 50
6. Return list with receipt URL: `/api/routes-d/local/offline-verification/receipt/{paymentId}`

---

### 3.4 Download Receipt (Authenticated)
**File**: [app/api/routes-d/local/offline-verification/receipt/[paymentId]/route.ts](app/api/routes-d/local/offline-verification/receipt/[paymentId]/route.ts) (create new)

**Endpoint**: `GET /api/routes-d/local/offline-verification/receipt/{paymentId}`

**Auth**: Required

**Logic**:
1. Verify auth, get user
2. Fetch `ManualPayment` with invoice
3. Verify ownership: `invoice.userId === user.id` (else 403)
4. Get absolute path: `getReceiptAbsolutePath(payment.receiptUrl)`
5. Validate path (prevent traversal)
6. Check file exists (else 404)
7. Read file, determine MIME type from extension
8. Return file with headers:
   - `Content-Type`: image/jpeg | image/png | application/pdf
   - `Content-Disposition`: inline
   - `Cache-Control`: private, max-age=3600

**Security**: Path traversal protection via `getReceiptAbsolutePath()` validation.

---

## Phase 4: Email Templates

**File**: [lib/email.ts](lib/email.ts) (modify existing)

### 4.1 Add Notification Functions

```typescript
// Notify freelancer: Client submitted receipt
export async function sendManualPaymentNotification(params: {
  to: string
  freelancerName: string
  invoiceNumber: string
  clientName: string
  amountPaid: number
  currency: string
  notes?: string
}) {
  return sendEmail({
    to: params.to,
    subject: `🔔 Payment Proof Received - ${params.invoiceNumber}`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
        <h2>Payment Proof Received</h2>
        <p>Hi ${params.freelancerName},</p>
        <p>A client has submitted proof of bank transfer payment for invoice <strong>${params.invoiceNumber}</strong>.</p>

        <div style="background: #F3F4F6; padding: 20px; border-radius: 12px; margin: 20px 0;">
          <p style="margin: 5px 0;"><strong>Client:</strong> ${params.clientName}</p>
          <p style="margin: 5px 0;"><strong>Amount:</strong> ${params.currency} ${params.amountPaid.toLocaleString()}</p>
          ${params.notes ? `<p style="margin: 5px 0;"><strong>Notes:</strong> ${params.notes}</p>` : ''}
        </div>

        <p><strong>Action Required:</strong> Please review the payment receipt and confirm or reject it from your dashboard.</p>

        <p style="color: #666; font-size: 12px; margin-top: 20px;">LancePay - Get paid globally, withdraw locally</p>
      </div>
    `,
  })
}

// Notify client: Payment verified
export async function sendManualPaymentVerifiedEmail(params: {
  to: string
  clientName: string
  invoiceNumber: string
  amountPaid: number
  currency: string
}) {
  return sendEmail({
    to: params.to,
    subject: `✅ Payment Confirmed - ${params.invoiceNumber}`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #10B981;">Payment Confirmed! ✅</h2>
        <p>Hi ${params.clientName},</p>
        <p>Great news! Your bank transfer payment for invoice <strong>${params.invoiceNumber}</strong> has been verified.</p>

        <div style="background: #ECFDF5; border: 1px solid #A7F3D0; padding: 20px; border-radius: 12px; margin: 20px 0;">
          <p style="margin: 5px 0; color: #065F46;"><strong>Amount Paid:</strong> ${params.currency} ${params.amountPaid.toLocaleString()}</p>
          <p style="margin: 5px 0; color: #065F46;"><strong>Status:</strong> Verified & Credited</p>
        </div>

        <p>The freelancer has received the payment in USDC on the Stellar network.</p>

        <p style="color: #666; font-size: 12px; margin-top: 20px;">Thank you for using LancePay!</p>
      </div>
    `,
  })
}
```

---

## Phase 5: UI Components (Basic)

### 5.1 Receipt Upload Form
**File**: [components/offline-verification/ReceiptUploadForm.tsx](components/offline-verification/ReceiptUploadForm.tsx) (create new)

```typescript
'use client'

import { useState } from 'react'

interface ReceiptUploadFormProps {
  invoiceNumber: string
  defaultClientName?: string
}

export function ReceiptUploadForm({ invoiceNumber, defaultClientName }: ReceiptUploadFormProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const [formData, setFormData] = useState({
    clientName: defaultClientName || '',
    amountPaid: '',
    currency: 'NGN',
    notes: '',
  })

  const [file, setFile] = useState<File | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      if (!file) throw new Error('Please select a receipt file')

      const form = new FormData()
      form.append('invoiceNumber', invoiceNumber)
      form.append('clientName', formData.clientName)
      form.append('amountPaid', formData.amountPaid)
      form.append('currency', formData.currency)
      form.append('notes', formData.notes)
      form.append('receipt', file)

      const res = await fetch('/api/routes-d/local/offline-verification/submit', {
        method: 'POST',
        body: form,
      })

      const data = await res.json()

      if (!res.ok) throw new Error(data.error || 'Failed to submit')

      setSuccess(true)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div className="p-6 bg-green-50 border border-green-200 rounded-lg">
        <h3 className="text-lg font-semibold text-green-900">Payment Proof Submitted!</h3>
        <p className="text-green-700 mt-2">
          Your payment proof has been submitted. The freelancer will verify it shortly.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">Your Name</label>
        <input
          type="text"
          required
          value={formData.clientName}
          onChange={(e) => setFormData({ ...formData, clientName: e.target.value })}
          className="w-full px-3 py-2 border rounded-lg"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Amount Paid (NGN)</label>
        <input
          type="number"
          required
          step="0.01"
          value={formData.amountPaid}
          onChange={(e) => setFormData({ ...formData, amountPaid: e.target.value })}
          className="w-full px-3 py-2 border rounded-lg"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Upload Receipt</label>
        <input
          type="file"
          required
          accept=".jpg,.jpeg,.png,.webp,.heic,.pdf"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          className="w-full px-3 py-2 border rounded-lg"
        />
        <p className="text-xs text-gray-500 mt-1">
          JPG, PNG, WEBP, HEIC, PDF (max 10MB)
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Notes (Optional)</label>
        <textarea
          value={formData.notes}
          onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
          className="w-full px-3 py-2 border rounded-lg"
          rows={3}
        />
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? 'Submitting...' : 'Submit Payment Proof'}
      </button>
    </form>
  )
}
```

---

### 5.2 Manual Payment Card
**File**: [components/offline-verification/ManualPaymentCard.tsx](components/offline-verification/ManualPaymentCard.tsx) (create new)

```typescript
'use client'

import { useState } from 'react'

interface ManualPaymentCardProps {
  payment: {
    id: string
    invoiceNumber: string
    clientName: string
    amountPaid: number
    currency: string
    receiptUrl: string
    status: string
    notes: string | null
    createdAt: string
    invoice: {
      expectedAmount: number
      expectedCurrency: string
    }
  }
  onVerify?: (paymentId: string, action: 'confirm' | 'reject', notes?: string) => void
}

export function ManualPaymentCard({ payment, onVerify }: ManualPaymentCardProps) {
  const [showReceipt, setShowReceipt] = useState(false)
  const [verifyNotes, setVerifyNotes] = useState('')

  const statusColors = {
    pending: 'bg-yellow-100 text-yellow-800',
    verified: 'bg-green-100 text-green-800',
    rejected: 'bg-red-100 text-red-800',
  }

  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex justify-between items-start">
        <div>
          <h3 className="font-semibold">Invoice: {payment.invoiceNumber}</h3>
          <p className="text-sm text-gray-600">From: {payment.clientName}</p>
        </div>
        <span className={`px-2 py-1 rounded text-xs font-medium ${statusColors[payment.status as keyof typeof statusColors]}`}>
          {payment.status}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <p className="text-gray-600">Paid Amount:</p>
          <p className="font-semibold">{payment.currency} {payment.amountPaid.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-gray-600">Expected:</p>
          <p className="font-semibold">{payment.invoice.expectedCurrency} {payment.invoice.expectedAmount}</p>
        </div>
      </div>

      {payment.notes && (
        <div className="text-sm bg-gray-50 p-2 rounded">
          <p className="text-gray-600">Notes:</p>
          <p>{payment.notes}</p>
        </div>
      )}

      <button
        onClick={() => setShowReceipt(!showReceipt)}
        className="text-blue-600 text-sm hover:underline"
      >
        {showReceipt ? 'Hide' : 'View'} Receipt
      </button>

      {showReceipt && (
        <div className="border-t pt-3">
          <img
            src={payment.receiptUrl}
            alt="Payment receipt"
            className="max-w-full rounded"
          />
        </div>
      )}

      {payment.status === 'pending' && onVerify && (
        <div className="border-t pt-3 space-y-2">
          <textarea
            placeholder="Add verification notes (optional)"
            value={verifyNotes}
            onChange={(e) => setVerifyNotes(e.target.value)}
            className="w-full px-3 py-2 border rounded text-sm"
            rows={2}
          />
          <div className="flex gap-2">
            <button
              onClick={() => onVerify(payment.id, 'confirm', verifyNotes)}
              className="flex-1 bg-green-600 text-white py-2 rounded hover:bg-green-700"
            >
              Confirm Payment
            </button>
            <button
              onClick={() => onVerify(payment.id, 'reject', verifyNotes)}
              className="flex-1 bg-red-600 text-white py-2 rounded hover:bg-red-700"
            >
              Reject
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
```

---

### 5.3 Verification Controls
**File**: [components/offline-verification/VerificationControls.tsx](components/offline-verification/VerificationControls.tsx) (create new)

```typescript
'use client'

import { useState } from 'react'

interface VerificationControlsProps {
  paymentId: string
  onSuccess?: () => void
  authToken: string
}

export function VerificationControls({ paymentId, onSuccess, authToken }: VerificationControlsProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState('')

  const handleVerify = async (action: 'confirm' | 'reject') => {
    setError(null)
    setLoading(true)

    try {
      const res = await fetch('/api/routes-d/local/offline-verification/verify', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          paymentId,
          action,
          notes: notes || undefined,
        }),
      })

      const data = await res.json()

      if (!res.ok) throw new Error(data.error || 'Verification failed')

      onSuccess?.()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium mb-1">Verification Notes (Optional)</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="w-full px-3 py-2 border rounded-lg"
          rows={3}
          placeholder="Add notes about this verification..."
        />
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={() => handleVerify('confirm')}
          disabled={loading}
          className="flex-1 bg-green-600 text-white py-2 px-4 rounded-lg hover:bg-green-700 disabled:opacity-50"
        >
          {loading ? 'Processing...' : 'Confirm Payment'}
        </button>
        <button
          onClick={() => handleVerify('reject')}
          disabled={loading}
          className="flex-1 bg-red-600 text-white py-2 px-4 rounded-lg hover:bg-red-700 disabled:opacity-50"
        >
          Reject
        </button>
      </div>
    </div>
  )
}
```

---

## Phase 6: Security & Edge Cases

### 6.1 Security Measures
- **File Upload**: MIME validation, extension whitelist, size limits, filename sanitization
- **Path Traversal**: `getReceiptAbsolutePath()` validates paths stay within `uploads/`
- **Auth**: JWT verification on all endpoints except submit (public like payment page)
- **Ownership**: Invoice ownership verified before verification and receipt access
- **Input Validation**: Zod schemas for all request bodies

### 6.2 Edge Cases Handled
- **Duplicate Submissions**: Check for pending payment within 1 hour → 409
- **Invoice Already Paid**: Validate invoice status before accept/verification
- **Concurrent Verifications**: Status check (idempotency) → 409 if already verified
- **Stellar Failure**: Try-catch, return 500 without DB changes, user can retry
- **Exchange Rate Failure**: Fallback to 1600 NGN/USD (built into `getUsdToNgnRate()`)
- **Missing Wallet**: Validate before Stellar transaction → 400
- **File Storage Failure**: Catch before DB write → 500, no orphaned records
- **Email Failures**: Non-blocking, catch and log, don't fail request
- **Receipt File Missing**: Check existence before serving → 404

---

## Phase 7: Testing Checklist

### Manual Testing

**Submit Flow**:
- [ ] Upload receipt for pending invoice → success, record created
- [ ] Upload for paid invoice → 400 error
- [ ] Upload duplicate (within 1 hour) → 409 error
- [ ] Upload invalid file type → 400 error
- [ ] Upload oversized file → 400 error
- [ ] Freelancer receives email notification

**Verify Flow**:
- [ ] Confirm payment → invoice paid, USDC credited to wallet, status verified
- [ ] Reject payment → status updated to rejected
- [ ] Verify without auth → 401 error
- [ ] Verify someone else's payment → 403 error
- [ ] Verify already verified payment → 409 error
- [ ] Client receives confirmation email

**List Flow**:
- [ ] Fetch pending payments → correct list
- [ ] Filter by status → correct filtering
- [ ] No auth → 401 error
- [ ] Only sees own invoices' payments

**Receipt Access**:
- [ ] Download with auth → file served
- [ ] Download without auth → 401 error
- [ ] Download someone else's receipt → 403 error
- [ ] Download non-existent receipt → 404 error

**Security**:
- [ ] Attempt path traversal in filename (`../../etc/passwd`)
- [ ] Attempt to access other users' receipts
- [ ] Test concurrent verification attempts

### Integration Testing

End-to-end flow:
1. Client submits receipt via `ReceiptUploadForm`
2. Freelancer receives email notification
3. Freelancer views pending payment list
4. Freelancer views receipt image
5. Freelancer confirms payment
6. Verify USDC credited (check Stellar testnet)
7. Verify invoice status = "paid"
8. Verify Transaction record created with txHash
9. Client receives confirmation email
10. Audit event logged

---

## Phase 8: Deployment

### 8.1 Pre-Deployment
- [ ] Create `uploads/receipts/` directory on server
- [ ] Set directory permissions (app write access only, no web access)
- [ ] Verify `STELLAR_FUNDING_WALLET_SECRET` env var is set
- [ ] Run Prisma migration on production DB

### 8.2 Environment Variables
**Required** (already exists):
- `STELLAR_FUNDING_WALLET_SECRET`: Funding wallet for crediting USDC

**No new env vars needed.**

### 8.3 Post-Deployment
- [ ] Test file upload in production
- [ ] Monitor disk space for `uploads/` directory
- [ ] Set up alerts for Stellar transaction failures
- [ ] Configure backup for uploads directory

### 8.4 Future Enhancements
- **File Cleanup**: Cron job to delete old receipts (90-day retention)
- **Cloud Storage**: Migrate to S3/Cloudinary for scalability
- **OCR Verification**: Auto-extract amount from receipt
- **Rate Limiting**: Add to submit endpoint
- **Admin Dashboard**: View all pending verifications

---

## Critical Files Summary

### New Files to Create
1. [lib/file-storage.ts](lib/file-storage.ts) - File validation and storage utilities
2. [app/api/routes-d/local/offline-verification/submit/route.ts](app/api/routes-d/local/offline-verification/submit/route.ts) - Public receipt submission
3. [app/api/routes-d/local/offline-verification/verify/route.ts](app/api/routes-d/local/offline-verification/verify/route.ts) - Confirm/reject payment (core logic)
4. [app/api/routes-d/local/offline-verification/list/route.ts](app/api/routes-d/local/offline-verification/list/route.ts) - List payments
5. [app/api/routes-d/local/offline-verification/receipt/[paymentId]/route.ts](app/api/routes-d/local/offline-verification/receipt/[paymentId]/route.ts) - Download receipt
6. [components/offline-verification/ReceiptUploadForm.tsx](components/offline-verification/ReceiptUploadForm.tsx) - Client upload form
7. [components/offline-verification/ManualPaymentCard.tsx](components/offline-verification/ManualPaymentCard.tsx) - Payment display card
8. [components/offline-verification/VerificationControls.tsx](components/offline-verification/VerificationControls.tsx) - Confirm/reject controls

### Files to Modify
1. [prisma/schema.prisma](prisma/schema.prisma) - Add `ManualPayment` model
2. [lib/email.ts](lib/email.ts) - Add 2 new email functions

### Key Dependencies
- **Existing Functions**: `sendUSDCPayment()`, `getUsdToNgnRate()`, `verifyAuthToken()`, `logAuditEvent()`
- **Existing Models**: Invoice, Transaction, User, Wallet
- **Existing Patterns**: Auth flow, email notifications, audit logging

---

## Verification Steps

After implementation, verify:

1. **Database**: Check `ManualPayment` table exists with correct schema
2. **File Storage**: Upload receipt → file created in `uploads/receipts/{invoiceId}/`
3. **Submit API**: POST with FormData → manual_payments record created with status "pending"
4. **Email**: Freelancer receives notification with invoice details
5. **List API**: GET with auth → returns pending payments for user's invoices
6. **Receipt API**: GET with auth → returns file with correct MIME type
7. **Verify API (Confirm)**: PATCH → Stellar transaction executes, invoice paid, USDC credited
8. **Stellar Network**: Query wallet on Horizon → USDC balance increased
9. **Transaction Record**: Check DB → type "incoming", status "completed", txHash present
10. **Client Email**: Confirmation sent with payment details
11. **Audit Log**: Event "invoice.paid.manual" logged with signature
12. **Security**: Attempt to access other user's receipt → 403 error

---

## Implementation Order

1. **Phase 1**: Database schema (15 min)
2. **Phase 2**: File storage utility (30 min)
3. **Phase 3**: API endpoints (2-3 hours)
   - Start with submit (simpler)
   - Then verify (complex, integrates with Stellar)
   - Then list, get single, receipt download
4. **Phase 4**: Email templates (30 min)
5. **Phase 5**: UI components (1-2 hours)
6. **Phase 6**: Security review (30 min)
7. **Phase 7**: Testing (1-2 hours)
8. **Phase 8**: Deployment (30 min)

**Total Estimate**: 6-8 hours for experienced developer

---

## Questions for Stakeholder

None - all requirements clarified. Ready to implement.
