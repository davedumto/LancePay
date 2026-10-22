import { describe, it, expect } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'
import { DEFAULT_SANDBOX_SEED, generateSandboxDataset } from '@/lib/sandbox-seed'

describe('generateSandboxDataset', () => {
  it('is reproducible for the same session and seed', () => {
    expect(generateSandboxDataset('s1', 'seed')).toEqual(generateSandboxDataset('s1', 'seed'))
  })

  it('differs only by id namespace across sessions with the same seed', () => {
    const a = JSON.stringify(generateSandboxDataset('aaa', DEFAULT_SANDBOX_SEED)).replaceAll('aaa', 'X')
    const b = JSON.stringify(generateSandboxDataset('bbb', DEFAULT_SANDBOX_SEED)).replaceAll('bbb', 'X')
    expect(a).toBe(b)
  })

  it('produces different data for different seeds', () => {
    const a = generateSandboxDataset('s1', 'one')
    const b = generateSandboxDataset('s1', 'two')
    expect(a.wallets.map((w) => w.address)).not.toEqual(b.wallets.map((w) => w.address))
  })

  it('links wallets and invoices to seeded users with schema-shaped fields', () => {
    const { users, wallets, invoices } = generateSandboxDataset('s1')
    const userIds = new Set(users.map((u) => u.id))

    for (const wallet of wallets) {
      expect(userIds.has(wallet.userId)).toBe(true)
      expect(StrKey.isValidEd25519PublicKey(wallet.address)).toBe(true)
    }
    for (const invoice of invoices) {
      expect(userIds.has(invoice.userId)).toBe(true)
      expect(invoice.amount).toMatch(/^\d+\.\d{2}$/)
      expect(['pending', 'paid', 'overdue']).toContain(invoice.status)
      expect(Number.isNaN(Date.parse(invoice.dueDate))).toBe(false)
    }
    expect(new Set(invoices.map((i) => i.invoiceNumber)).size).toBe(invoices.length)
  })
})
