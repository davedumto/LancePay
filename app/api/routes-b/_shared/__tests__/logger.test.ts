import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockChild } = vi.hoisted(() => {
  const mockChild = vi.fn().mockReturnValue({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })
  return { mockChild }
})

vi.mock('@/lib/logger', () => ({
  logger: { child: mockChild },
  default: { child: mockChild },
}))

import { createRouteLogger, logger } from '../logger'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createRouteLogger', () => {
  it('creates a child logger with namespace routes-b', () => {
    createRouteLogger({ route: '/api/routes-b/contacts' })
    expect(mockChild).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'routes-b', route: '/api/routes-b/contacts' }),
    )
  })

  it('propagates extra context fields to the child logger', () => {
    createRouteLogger({ route: '/api/routes-b/invoices', userId: 'user-42' })
    expect(mockChild).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-42' }),
    )
  })

  it('returns a logger object with error and info methods', () => {
    const childLogger = createRouteLogger({ route: '/api/routes-b/branding' })
    expect(typeof childLogger.error).toBe('function')
    expect(typeof childLogger.info).toBe('function')
  })

  it('calls child on the base logger instance once per call', () => {
    createRouteLogger({ route: '/api/routes-b/wallet' })
    expect(mockChild).toHaveBeenCalledTimes(1)
  })

  it('re-exports the base logger as logger', () => {
    expect(logger).toBeDefined()
    expect(typeof logger.child).toBe('function')
  })
})
