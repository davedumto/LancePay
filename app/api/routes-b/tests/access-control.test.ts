import { describe, expect, test } from 'vitest'
import { checkResourceOwnership, checkScopeAccess } from '../_lib/access-control'

describe('Access Control', () => {
  test('checkResourceOwnership returns 404 for cross-user', () => {
    const response = checkResourceOwnership('user1', 'user2')
    expect(response?.status).toBe(404)
  })

  test('checkResourceOwnership returns null for same user', () => {
    const response = checkResourceOwnership('user1', 'user1')
    expect(response).toBeNull()
  })

  test('checkScopeAccess returns 403 for false', () => {
    const response = checkScopeAccess(false)
    expect(response?.status).toBe(403)
  })

  test('checkScopeAccess returns null for true', () => {
    const response = checkScopeAccess(true)
    expect(response).toBeNull()
  })
})
