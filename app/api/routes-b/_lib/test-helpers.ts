import { NextRequest } from 'next/server'

export function buildRequest(
  method: string,
  url: string,
  options?: {
    token?: string
    body?: unknown
  },
) {
  const headers: Record<string, string> = {}
  if (options?.token) {
    headers.authorization = `Bearer ${options.token}`
  }

  return new NextRequest(url, {
    method,
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
}

export function buildParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

export function makeUser(overrides?: Partial<{ id: string; privyId: string }>) {
  return {
    id: overrides?.id ?? 'user-1',
    privyId: overrides?.privyId ?? 'privy-1',
  }
}

export function makeTag(
  overrides?: Partial<{
    id: string
    userId: string
    name: string
    color: string
    createdAt: Date
    invoiceCount: number
  }>,
) {
  return {
    id: overrides?.id ?? 'tag-1',
    userId: overrides?.userId ?? 'user-1',
    name: overrides?.name ?? 'Alpha',
    color: overrides?.color ?? '#6366f1',
    createdAt: overrides?.createdAt ?? new Date('2026-01-01T00:00:00.000Z'),
    _count: {
      invoiceTags: overrides?.invoiceCount ?? 0,
    },
  }
}

