import { describe, expect, test, beforeAll, afterEach } from 'vitest'
import { createSchedule, getSchedules, clearSchedules } from '../_lib/withdrawal-scheduler'

describe('Withdrawals Schedules (In-Memory)', () => {
  beforeAll(() => {
    clearSchedules()
  })

  afterEach(() => {
    clearSchedules()
  })

  test('should create a schedule', () => {
    const schedule = createSchedule({
      userId: 'user_123',
      bankId: 'bank_123',
      cadence: 'weekly',
      dayOfWeek: 5,
      percentOrAmount: { type: 'percent', value: 100 }
    })
    expect(schedule.id).toBeDefined()
    expect(schedule.userId).toBe('user_123')
  })

  test('should retrieve schedules by user', () => {
    createSchedule({
      userId: 'user_123',
      bankId: 'bank_123',
      cadence: 'monthly',
      dayOfMonth: 1,
      percentOrAmount: { type: 'amount', value: 500 }
    })
    
    createSchedule({
      userId: 'user_456',
      bankId: 'bank_456',
      cadence: 'weekly',
      dayOfWeek: 1,
      percentOrAmount: { type: 'amount', value: 500 }
    })

    const user1Schedules = getSchedules('user_123')
    expect(user1Schedules.length).toBe(1)
    expect(user1Schedules[0].bankId).toBe('bank_123')
  })
})
