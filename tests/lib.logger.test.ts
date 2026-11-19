import { describe, expect, it, vi } from 'vitest'
import pino from 'pino'
import { logError, redact } from '@/lib/logger'

const sensitivePaths = [
  ['req', 'headers', 'authorization'],
  ['authorization'],
  ['req', 'headers', 'cookie'],
  ['cookie'],
  ['req', 'headers', 'x-yc-signature'],
  ['x-yc-signature'],
  ['req', 'headers', 'moonpay-signature'],
  ['moonpay-signature'],
  ['req', 'headers', 'moonpay-signature-v2'],
  ['moonpay-signature-v2'],
  ['req', 'headers', 'signature'],
  ['signature'],
  ['apiKey'],
  ['api_key'],
  ['accessToken'],
  ['access_token'],
  ['refreshToken'],
  ['refresh_token'],
  ['secret'],
  ['clientSecret'],
  ['client_secret'],
  ['webhookSecret'],
  ['webhook_secret'],
  ['privateKey'],
  ['private_key'],
  ['password'],
  ['accountNumber'],
  ['twoFactorSecret'],
]

function nestedValue(path: string[]) {
  const root: Record<string, unknown> = {}
  let current = root
  path.forEach((key, index) => {
    if (index === path.length - 1) {
      current[key] = 'sensitive-value'
    } else {
      current[key] = {}
      current = current[key] as Record<string, unknown>
    }
  })
  return root
}

describe('logger redaction', () => {
  it('censors every configured sensitive path in pino output', async () => {
    const lines: string[] = []
    const capture = pino({ redact, base: undefined }, {
      write(message: string) { lines.push(message) },
    })

    for (const path of sensitivePaths) {
      capture.info(nestedValue(path))
    }

    const output = lines.join('\n')
    expect(output).not.toContain('sensitive-value')
    expect((output.match(/\[Redacted\]/g) ?? []).length).toBe(sensitivePaths.length)
  })

  it('strips sensitive fields from logError errorInfo', () => {
    const errorInfo = {
      authorization: 'Bearer token',
      accountNumber: '000123456789',
      twoFactorSecret: 'totp-secret',
      context: { clientSecret: 'secret-value', safe: 'visible-value' },
    }
    const lines: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((message: string | Uint8Array) => {
      lines.push(String(message))
      return true
    }) as any)

    logError(new Error('test failure'), errorInfo)
    write.mockRestore()

    expect(lines.join('\n')).not.toContain('Bearer token')
    expect(lines.join('\n')).not.toContain('000123456789')
    expect(lines.join('\n')).not.toContain('totp-secret')
    expect(lines.join('\n')).not.toContain('secret-value')
    expect(lines.join('\n')).toContain('visible-value')
  })
})
