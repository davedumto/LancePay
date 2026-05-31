import { describe, it, expect } from 'vitest'
import {
  createErrorResponse,
  unauthorized,
  forbidden,
  notFound,
  badRequest,
  conflict,
  preconditionFailed,
  unprocessableEntity,
  internalServerError,
} from '../error'

describe('Error envelope helpers', () => {
  it('creates error response with message and status', async () => {
    const res = createErrorResponse('Test error', 400, 'BAD_REQUEST')
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('Test error')
    expect(json.code).toBe('BAD_REQUEST')
  })

  it('includes details in error response', async () => {
    const res = createErrorResponse('Validation failed', 400, 'BAD_REQUEST', {
      field: 'email',
      reason: 'Invalid format',
    })
    const json = await res.json()
    expect(json.details).toEqual({
      field: 'email',
      reason: 'Invalid format',
    })
  })

  it('unauthorized returns 401', async () => {
    const res = unauthorized()
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Unauthorized')
    expect(json.code).toBe('UNAUTHORIZED')
  })

  it('unauthorized accepts custom message', async () => {
    const res = unauthorized('Token expired')
    const json = await res.json()
    expect(json.error).toBe('Token expired')
  })

  it('forbidden returns 403', async () => {
    const res = forbidden()
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.error).toBe('Forbidden')
    expect(json.code).toBe('FORBIDDEN')
  })

  it('notFound returns 404', async () => {
    const res = notFound('Resource not found')
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('Resource not found')
    expect(json.code).toBe('NOT_FOUND')
  })

  it('badRequest returns 400 with details', async () => {
    const res = badRequest('Invalid input', { field: 'name' })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.code).toBe('BAD_REQUEST')
    expect(json.details).toEqual({ field: 'name' })
  })

  it('conflict returns 409', async () => {
    const res = conflict('Resource already exists')
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toBe('Resource already exists')
    expect(json.code).toBe('CONFLICT')
  })

  it('preconditionFailed returns 412', async () => {
    const res = preconditionFailed('ETag mismatch')
    expect(res.status).toBe(412)
    const json = await res.json()
    expect(json.error).toBe('ETag mismatch')
    expect(json.code).toBe('PRECONDITION_FAILED')
  })

  it('unprocessableEntity returns 422', async () => {
    const res = unprocessableEntity('Cannot update non-pending invoice')
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.error).toBe('Cannot update non-pending invoice')
    expect(json.code).toBe('UNPROCESSABLE_ENTITY')
  })

  it('internalServerError returns 500', async () => {
    const res = internalServerError()
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('Internal Server Error')
    expect(json.code).toBe('INTERNAL_SERVER_ERROR')
  })

  it('internalServerError accepts custom message', async () => {
    const res = internalServerError('Database connection failed')
    const json = await res.json()
    expect(json.error).toBe('Database connection failed')
  })
})
