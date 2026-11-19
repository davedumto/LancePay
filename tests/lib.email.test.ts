import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mocks.send }
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: mocks.loggerError },
}))

import { sendEmail } from '@/lib/email'

const params = { to: 'user@example.com', subject: 'Test email', html: '<p>Hello</p>' }

describe('sendEmail configuration', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NODE_ENV = 'production'
    process.env.RESEND_API_KEY = 're_test_key'
    process.env.RESEND_FROM = 'LancePay <verified@example.com>'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('sends through Resend when production credentials are configured', async () => {
    mocks.send.mockResolvedValue({ data: { id: 'email_1' }, error: null })

    await expect(sendEmail(params)).resolves.toEqual({ success: true, id: 'email_1' })
    expect(mocks.send).toHaveBeenCalledWith({
      from: 'LancePay <verified@example.com>',
      to: [params.to],
      subject: params.subject,
      html: params.html,
    })
  })

  it('fails fast and logs a clear error when production credentials are missing', async () => {
    delete process.env.RESEND_API_KEY
    delete process.env.RESEND_FROM

    await expect(sendEmail(params)).resolves.toEqual({ success: false, reason: 'not_configured' })
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.loggerError).toHaveBeenCalledWith(
      { missing: ['RESEND_API_KEY', 'RESEND_FROM'] },
      'Resend is not configured; refusing to send email in production'
    )
  })

  it('logs the rendered email instead of calling Resend in development', async () => {
    process.env.NODE_ENV = 'development'
    delete process.env.RESEND_API_KEY
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(sendEmail(params)).resolves.toEqual({ success: false, reason: 'development' })
    expect(consoleLog).toHaveBeenCalledWith(params.html)
    expect(mocks.send).not.toHaveBeenCalled()
    consoleLog.mockRestore()
  })

  it('returns a provider failure result when Resend rejects the send', async () => {
    const providerError = new Error('Resend unavailable')
    mocks.send.mockRejectedValue(providerError)

    await expect(sendEmail(params)).resolves.toEqual({
      success: false,
      reason: 'provider_error',
      error: providerError,
    })
    expect(mocks.loggerError).toHaveBeenCalled()
  })

  it('returns a provider failure result when Resend responds with an error', async () => {
    const providerError = { name: 'validation_error', message: 'Invalid recipient' }
    mocks.send.mockResolvedValue({ data: null, error: providerError })

    await expect(sendEmail(params)).resolves.toEqual({
      success: false,
      reason: 'provider_error',
      error: providerError,
    })
  })
})
