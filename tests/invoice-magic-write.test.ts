import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Mirrors the snapshot guard in components/invoices/invoice-form.tsx:
// the AI result is only applied when the description has not changed
// since the request was fired.
function applyMagicWriteResult(
  currentDescription: string,
  snapshot: string,
  aiDescription: string,
): string {
  return currentDescription === snapshot ? aiDescription : currentDescription
}

describe('Magic Write in-flight edit guard (#1519)', () => {
  it('does not silently discard a user edit made during an in-flight request', () => {
    const snapshot = 'logo design'
    const userEdited = 'logo design for Acme Corp, rush job'
    const aiResult = 'Professional logo design services.'

    // User typed while generation was in flight -> keep their edit
    expect(applyMagicWriteResult(userEdited, snapshot, aiResult)).toBe(userEdited)
    // Description untouched since request fired -> safe to apply AI result
    expect(applyMagicWriteResult(snapshot, snapshot, aiResult)).toBe(aiResult)
  })

  it('locks the description field while generating and guards the AI write', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'components/invoices/invoice-form.tsx'),
      'utf8',
    )

    // The textarea must be locked while the request is in flight ...
    expect(source).toMatch(/readOnly=\{isGenerating\}|disabled=\{isGenerating\}/)
    // ... and the AI response must only apply when the description
    // has not changed since the request was fired (snapshot guard).
    expect(source).toContain('const snapshot = form.description')
    expect(source).toMatch(/prev\.description === snapshot/)
  })
})
