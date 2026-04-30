import { randomUUID } from 'crypto'

export interface WithdrawalSchedule {
  id: string
  userId: string
  bankId: string
  cadence: 'weekly' | 'monthly'
  dayOfWeek?: number
  dayOfMonth?: number
  percentOrAmount: { type: 'percent' | 'amount'; value: number }
  createdAt: Date
}

const schedules = new Map<string, WithdrawalSchedule>()

export function createSchedule(data: Omit<WithdrawalSchedule, 'id' | 'createdAt'>): WithdrawalSchedule {
  const id = randomUUID()
  const entry = { ...data, id, createdAt: new Date() }
  schedules.set(id, entry)
  return entry
}

export function getSchedules(userId: string): WithdrawalSchedule[] {
  return Array.from(schedules.values()).filter(s => s.userId === userId)
}

export function getSchedule(id: string): WithdrawalSchedule | null {
  return schedules.get(id) ?? null
}

export function updateSchedule(id: string, updates: Partial<Omit<WithdrawalSchedule, 'id' | 'userId' | 'createdAt'>>): WithdrawalSchedule | null {
  const entry = schedules.get(id)
  if (!entry) return null
  const updated = { ...entry, ...updates }
  schedules.set(id, updated)
  return updated
}

export function deleteSchedule(id: string): boolean {
  return schedules.delete(id)
}

export function clearSchedules() {
  schedules.clear()
}
