import { describe, it, expect, beforeEach } from 'vitest'
import {
  snoozeNotification,
  unsnoozeNotification,
  isNotificationSnoozed,
  getSnoozedUntil,
  resetSnoozeStore,
} from '../../_lib/notification-snooze'

describe('notification snooze', () => {
  beforeEach(() => {
    resetSnoozeStore()
  })

  it('snoozed notification is hidden', () => {
    const future = new Date(Date.now() + 60_000)
    snoozeNotification('n1', future)
    expect(isNotificationSnoozed('n1')).toBe(true)
  })

  it('snoozed notification becomes visible after expiry', () => {
    const past = Date.now() - 1000
    snoozeNotification('n1', new Date(past))
    expect(isNotificationSnoozed('n1')).toBe(false)
  })

  it('unsnooze restores visibility immediately', () => {
    const future = new Date(Date.now() + 60_000)
    snoozeNotification('n1', future)
    expect(isNotificationSnoozed('n1')).toBe(true)
    unsnoozeNotification('n1')
    expect(isNotificationSnoozed('n1')).toBe(false)
  })

  it('non-snoozed notification is not snoozed', () => {
    expect(isNotificationSnoozed('unknown')).toBe(false)
  })

  it('getSnoozedUntil returns null for non-snoozed', () => {
    expect(getSnoozedUntil('unknown')).toBeNull()
  })

  it('getSnoozedUntil returns date for snoozed notification', () => {
    const until = new Date(Date.now() + 60_000)
    snoozeNotification('n1', until)
    const result = getSnoozedUntil('n1')
    expect(result).toBeInstanceOf(Date)
    expect(result!.getTime()).toBe(until.getTime())
  })

  it('getSnoozedUntil returns null after expiry', () => {
    const past = new Date(Date.now() - 1000)
    snoozeNotification('n1', past)
    expect(getSnoozedUntil('n1')).toBeNull()
  })

  it('snooze with until in the past rejects', () => {
    snoozeNotification('n1', new Date(Date.now() - 1000))
    expect(isNotificationSnoozed('n1')).toBe(false)
  })
})
