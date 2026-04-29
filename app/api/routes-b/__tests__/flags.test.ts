import { describe, it, expect, beforeEach, vi } from 'vitest'
import { isEnabled, clearFlagCache } from '../_lib/flags'

describe('feature flags', () => {
  beforeEach(() => {
    clearFlagCache()
    // Clear any env vars that might be set
    delete process.env.FLAG_TEST_FLAG
    delete process.env.FLAG_USER_FLAG
    delete process.env.FLAG_BULK_CONTACTS_IMPORT
  })

  it('returns false for unknown flag', () => {
    expect(isEnabled('unknown-flag')).toBe(false)
  })

  it('respects env FLAG_=on', () => {
    process.env.FLAG_TEST_FLAG = 'on'
    expect(isEnabled('test-flag')).toBe(true)
  })

  it('respects env FLAG_=off', () => {
    process.env.FLAG_TEST_FLAG = 'off'
    expect(isEnabled('test-flag')).toBe(false)
  })

  it('respects env FLAG_=user list', () => {
    process.env.FLAG_USER_FLAG = 'user1,user2,user3'
    expect(isEnabled('user-flag', { userId: 'user1' })).toBe(true)
    expect(isEnabled('user-flag', { userId: 'user2' })).toBe(true)
    expect(isEnabled('user-flag', { userId: 'user4' })).toBe(false)
    expect(isEnabled('user-flag')).toBe(false) // no userId
  })

  it('falls back to default map when env not set', () => {
    // bulk-contacts-import defaults to 'off'
    expect(isEnabled('bulk-contacts-import')).toBe(false)
    expect(isEnabled('presigned-uploads')).toBe(false)
    expect(isEnabled('sparkline-charts')).toBe(false)
    expect(isEnabled('webhook-event-filtering')).toBe(false)
  })

  it('memoizes per request', () => {
    process.env.FLAG_TEST_FLAG = 'on'
    expect(isEnabled('test-flag')).toBe(true)
    
    // Change env after first call - should still use cached value
    process.env.FLAG_TEST_FLAG = 'off'
    expect(isEnabled('test-flag')).toBe(true) // Still true from cache
    
    // Clear cache and check again
    clearFlagCache()
    expect(isEnabled('test-flag')).toBe(false) // Now false
  })

  it('handles malformed user list', () => {
    process.env.FLAG_TEST_FLAG = '  user1, ,user2,  '
    expect(isEnabled('test-flag', { userId: 'user1' })).toBe(true)
    expect(isEnabled('test-flag', { userId: 'user2' })).toBe(true)
    expect(isEnabled('test-flag', { userId: 'user3' })).toBe(false)
  })

  it('is case-insensitive for on/off', () => {
    process.env.FLAG_TEST_FLAG = 'ON'
    expect(isEnabled('test-flag')).toBe(true)
    
    clearFlagCache()
    process.env.FLAG_TEST_FLAG = 'OFF'
    expect(isEnabled('test-flag')).toBe(false)
  })
})