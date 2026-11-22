import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('Module Architecture Documentation (docs/MODULES.md)', () => {
  const rootDir = process.cwd()
  const modulesDocPath = path.join(rootDir, 'docs/MODULES.md')
  const readmePath = path.join(rootDir, 'README.md')

  it('verifies docs/MODULES.md exists and is linked from README.md', () => {
    expect(fs.existsSync(modulesDocPath)).toBe(true)
    const readmeContent = fs.readFileSync(readmePath, 'utf8')
    expect(readmeContent).toContain('docs/MODULES.md')
  })

  it('does not reference non-existent legacy directories or files', () => {
    const docContent = fs.readFileSync(modulesDocPath, 'utf8')

    // Disallowed ghost paths from previous inaccurate documentation
    expect(docContent).not.toMatch(/^├── modules\//m)
    expect(docContent).not.toContain('lib/redis.ts')
    expect(docContent).not.toContain('lib/blockchain.ts')
    expect(docContent).not.toContain('FreelancerPay402')
  })

  it('documents actual API route tier structure including routes-b and routes-d', () => {
    const docContent = fs.readFileSync(modulesDocPath, 'utf8')

    expect(docContent).toContain('routes-b')
    expect(docContent).toContain('routes-d')
    expect(fs.existsSync(path.join(rootDir, 'app/api/routes-b'))).toBe(true)
    expect(fs.existsSync(path.join(rootDir, 'app/api/routes-d'))).toBe(true)
  })

  it('verifies all documented core lib domain modules exist on disk', () => {
    const docContent = fs.readFileSync(modulesDocPath, 'utf8')

    const documentedLibFiles = [
      'lib/stellar.ts',
      'lib/stellar-funding.ts',
      'lib/claimable-balances.ts',
      'lib/sep24.ts',
      'lib/offramp.ts',
      'lib/withdrawal-ledger.ts',
      'lib/money.ts',
      'lib/pricing.ts',
      'lib/auth.ts',
      'lib/authorization.ts',
      'lib/kyc-config.ts',
      'lib/db.ts',
      'lib/logger.ts',
      'lib/validations.ts',
    ]

    for (const relativePath of documentedLibFiles) {
      expect(docContent).toContain(relativePath)
      expect(
        fs.existsSync(path.join(rootDir, relativePath)),
        `Expected ${relativePath} to exist on disk`,
      ).toBe(true)
    }
  })

  it('fails validation when checking for invalid or removed modules', () => {
    const fakePaths = ['lib/redis.ts', 'lib/blockchain.ts', 'modules/auth']
    for (const fake of fakePaths) {
      expect(fs.existsSync(path.join(rootDir, fake))).toBe(false)
    }
  })
})
