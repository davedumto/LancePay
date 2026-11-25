import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  MAX_TRANSACTION_HISTORY_RECORDS,
  fetchFullTransactionHistory,
  server,
  streamFullTransactionHistory,
} from '@/lib/stellar'

const PUBLIC_KEY = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4'

interface FakeRecord {
  transaction_hash: string
  type: string
  created_at: string
  transaction_successful: boolean
  from: string
  to: string
  amount?: string
  asset_code?: string
  asset_type?: string
}

function record(createdAt: string, index: number): FakeRecord {
  return {
    transaction_hash: `hash-${index}`,
    type: 'payment',
    created_at: createdAt,
    transaction_successful: true,
    from: PUBLIC_KEY,
    to: PUBLIC_KEY,
    amount: '1.00',
    asset_code: 'XLM',
    asset_type: 'native',
  }
}

/**
 * Stub server.payments() to serve the given pages of records. Each page is an
 * array of records; pagination ends when a page is empty.
 */
function mockPayments(pages: FakeRecord[][]) {
  let pageIndex = 0
  const makeResponse = () => {
    const records = pages[pageIndex] ?? []
    pageIndex += 1
    return {
      records,
      next: async () => makeResponse(),
    }
  }
  const builder = {
    forAccount: () => builder,
    order: () => builder,
    limit: () => builder,
    call: async () => makeResponse(),
  }
  return vi
    .spyOn(server, 'payments')
    .mockReturnValue(builder as unknown as ReturnType<typeof server.payments>)
}

const PAGE_1 = [
  record('2024-03-10T12:00:00Z', 1),
  record('2024-03-05T12:00:00Z', 2),
  record('2024-03-01T12:00:00Z', 3),
]
const PAGE_2 = [
  record('2024-02-20T12:00:00Z', 4),
  record('2024-02-10T12:00:00Z', 5),
]

describe('fetchFullTransactionHistory', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('collects records across multiple pages', async () => {
    mockPayments([PAGE_1, PAGE_2, []])

    const result = await fetchFullTransactionHistory(PUBLIC_KEY)

    expect(result.map((t) => t.transaction_hash)).toEqual([
      'hash-1',
      'hash-2',
      'hash-3',
      'hash-4',
      'hash-5',
    ])
  })

  it('treats startDate and endDate as inclusive bounds', async () => {
    mockPayments([PAGE_1, PAGE_2, []])

    const result = await fetchFullTransactionHistory(
      PUBLIC_KEY,
      new Date('2024-03-01T12:00:00Z'), // exactly hash-3's created_at
      new Date('2024-03-05T12:00:00Z'), // exactly hash-2's created_at
    )

    expect(result.map((t) => t.transaction_hash)).toEqual([
      'hash-2',
      'hash-3',
    ])
  })

  it('stops paginating once records fall before startDate', async () => {
    const paymentsSpy = mockPayments([PAGE_1, PAGE_2, [record('2024-01-01T00:00:00Z', 6)]])

    const result = await fetchFullTransactionHistory(
      PUBLIC_KEY,
      new Date('2024-02-15T00:00:00Z'),
    )

    expect(result.map((t) => t.transaction_hash)).toEqual([
      'hash-1',
      'hash-2',
      'hash-3',
      'hash-4',
    ])
    // PAGE_2's first record (2024-02-20) is still >= start, but the second
    // (2024-02-10) is not, so the generator stops before page 3 is fetched.
    expect(paymentsSpy).toHaveBeenCalledTimes(1)
  })

  it('skips records newer than endDate while paginating', async () => {
    mockPayments([PAGE_1, PAGE_2, []])

    const result = await fetchFullTransactionHistory(
      PUBLIC_KEY,
      undefined,
      new Date('2024-03-05T12:00:00Z'),
    )

    expect(result.map((t) => t.transaction_hash)).toEqual([
      'hash-2',
      'hash-3',
      'hash-4',
      'hash-5',
    ])
  })

  it('caps the array variant at MAX_TRANSACTION_HISTORY_RECORDS', async () => {
    const bigPage = Array.from({ length: MAX_TRANSACTION_HISTORY_RECORDS + 1 }, (_, i) =>
      record('2024-03-10T12:00:00Z', i),
    )
    mockPayments([bigPage])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await fetchFullTransactionHistory(PUBLIC_KEY)

    expect(result).toHaveLength(MAX_TRANSACTION_HISTORY_RECORDS)
    expect(warn).toHaveBeenCalled()
  })

  it('returns an empty array when Horizon fails', async () => {
    vi.spyOn(server, 'payments').mockImplementation(() => {
      throw new Error('horizon down')
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(fetchFullTransactionHistory(PUBLIC_KEY)).resolves.toEqual([])
  })
})

describe('streamFullTransactionHistory', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('yields the same records as the array variant', async () => {
    mockPayments([PAGE_1, PAGE_2, []])

    const streamed: string[] = []
    for await (const tx of streamFullTransactionHistory(PUBLIC_KEY)) {
      streamed.push(tx.transaction_hash)
    }

    expect(streamed).toEqual([
      'hash-1',
      'hash-2',
      'hash-3',
      'hash-4',
      'hash-5',
    ])
  })

  it('applies the same inclusive date bounds', async () => {
    mockPayments([PAGE_1, PAGE_2, []])

    const streamed: string[] = []
    for await (const tx of streamFullTransactionHistory(
      PUBLIC_KEY,
      new Date('2024-03-01T12:00:00Z'),
      new Date('2024-03-05T12:00:00Z'),
    )) {
      streamed.push(tx.transaction_hash)
    }

    expect(streamed).toEqual(['hash-2', 'hash-3'])
  })
})
