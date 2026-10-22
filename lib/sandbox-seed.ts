import { createHash } from 'crypto'
import { StrKey } from '@stellar/stellar-sdk'

// Deterministic fixtures for developer-portal sandbox sessions. The same seed
// always yields the same dataset; only the ids are namespaced by session so
// two sessions never collide. Field names mirror the User, Wallet and Invoice
// Prisma models so sandbox responses look like live ones.

export const DEFAULT_SANDBOX_SEED = 'lancepay-sandbox-v1'

const SANDBOX_USER_COUNT = 3
const SANDBOX_INVOICES_PER_USER = 2
// Fixed epoch keeps dates reproducible instead of drifting with Date.now().
const SANDBOX_EPOCH = Date.UTC(2026, 0, 1)
const DAY_MS = 24 * 60 * 60 * 1000

const FIRST_NAMES = ['Ada', 'Bayo', 'Chidi', 'Dami', 'Efe', 'Funmi', 'Gozie', 'Hauwa']
const LAST_NAMES = ['Okafor', 'Adeyemi', 'Bello', 'Eze', 'Lawal', 'Nwosu', 'Usman', 'Balogun']
const INVOICE_DESCRIPTIONS = [
  'Website redesign',
  'Mobile app sprint',
  'Logo and brand kit',
  'API integration',
  'Monthly retainer',
  'Content writing package',
]
const INVOICE_STATUSES = ['pending', 'paid', 'overdue'] as const

export interface SandboxUser {
  id: string
  email: string
  name: string
  role: string
}

export interface SandboxWallet {
  id: string
  userId: string
  address: string
}

export interface SandboxInvoice {
  id: string
  userId: string
  invoiceNumber: string
  clientEmail: string
  clientName: string
  description: string
  amount: string
  currency: string
  status: (typeof INVOICE_STATUSES)[number]
  dueDate: string
}

export interface SandboxDataset {
  users: SandboxUser[]
  wallets: SandboxWallet[]
  invoices: SandboxInvoice[]
}

/** Byte stream derived from SHA-256(seed:counter); stable across runtimes. */
function createSeededBytes(seed: string) {
  let counter = 0
  let buffer = Buffer.alloc(0)
  return (length: number): Buffer => {
    while (buffer.length < length) {
      const block = createHash('sha256').update(`${seed}:${counter++}`).digest()
      buffer = Buffer.concat([buffer, block])
    }
    const out = buffer.subarray(0, length)
    buffer = buffer.subarray(length)
    return out
  }
}

export function generateSandboxDataset(sessionId: string, seed: string = DEFAULT_SANDBOX_SEED): SandboxDataset {
  const nextBytes = createSeededBytes(seed)
  const nextInt = (max: number) => nextBytes(4).readUInt32BE(0) % max
  const prefix = `sbx_${sessionId}`

  const users: SandboxUser[] = []
  const wallets: SandboxWallet[] = []
  const invoices: SandboxInvoice[] = []

  for (let u = 1; u <= SANDBOX_USER_COUNT; u++) {
    const first = FIRST_NAMES[nextInt(FIRST_NAMES.length)]
    const last = LAST_NAMES[nextInt(LAST_NAMES.length)]
    const userId = `${prefix}_usr_${u}`

    users.push({
      id: userId,
      email: `${first}.${last}.${u}@sandbox.lancepay.test`.toLowerCase(),
      name: `${first} ${last}`,
      role: 'freelancer',
    })

    wallets.push({
      id: `${prefix}_wal_${u}`,
      userId,
      address: StrKey.encodeEd25519PublicKey(nextBytes(32)),
    })

    for (let i = 1; i <= SANDBOX_INVOICES_PER_USER; i++) {
      const n = (u - 1) * SANDBOX_INVOICES_PER_USER + i
      const clientFirst = FIRST_NAMES[nextInt(FIRST_NAMES.length)]
      const clientLast = LAST_NAMES[nextInt(LAST_NAMES.length)]
      const cents = 5_000 + nextInt(495_000) // $50.00 – $5,000.00

      invoices.push({
        id: `${prefix}_inv_${n}`,
        userId,
        invoiceNumber: `SBX-${String(n).padStart(4, '0')}`,
        clientEmail: `${clientFirst}.${clientLast}@client.sandbox.lancepay.test`.toLowerCase(),
        clientName: `${clientFirst} ${clientLast}`,
        description: INVOICE_DESCRIPTIONS[nextInt(INVOICE_DESCRIPTIONS.length)],
        amount: (cents / 100).toFixed(2),
        currency: 'USD',
        status: INVOICE_STATUSES[nextInt(INVOICE_STATUSES.length)],
        dueDate: new Date(SANDBOX_EPOCH + (7 + nextInt(53)) * DAY_MS).toISOString(),
      })
    }
  }

  return { users, wallets, invoices }
}
