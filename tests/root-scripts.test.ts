import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('Root scripts cleanup and reorganization', () => {
  const rootDir = path.resolve(__dirname, '..')

  it('ensures no ad-hoc scripts or output text files remain in the root directory', () => {
    const forbiddenPatterns = [
      /^fix.*\.js$/,
      /^fix_parser\.js$/,
      /^prisma_test\.js$/,
      /^test\.ts$/,
      /^test-.*\.js$/,
      /^test-.*\.ts$/,
      /^verify\.ps1$/,
      /^lint_out.*\.txt$/,
    ]

    const rootEntries = fs.readdirSync(rootDir, { withFileTypes: true })
    const offendingFiles: string[] = []

    for (const entry of rootEntries) {
      if (entry.isFile()) {
        if (forbiddenPatterns.some(pattern => pattern.test(entry.name))) {
          offendingFiles.push(entry.name)
        }
      }
    }

    expect(offendingFiles).toEqual([])
  })

  it('ensures relocated scripts exist in scripts/ with explanatory header comments', () => {
    const requiredScripts = [
      'test-fee-quote.js',
      'test-p-and-l.js',
      'test-path-payments.ts',
      'test-sponsored-reserves.ts',
      'verify-moonpay-webhook.ts',
    ]

    for (const scriptName of requiredScripts) {
      const scriptPath = path.join(rootDir, 'scripts', scriptName)
      expect(fs.existsSync(scriptPath)).toBe(true)

      const content = fs.readFileSync(scriptPath, 'utf8')
      // Header comment must explain purpose and usage
      expect(content).toMatch(/^\/\*\*[\s\S]*?\*\//)
      expect(content.toLowerCase()).toMatch(/usage|run/)
    }
  })

  it('verifies tsconfig.json excludes scripts from Next.js type check', () => {
    const tsconfigPath = path.join(rootDir, 'tsconfig.json')
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'))

    expect(tsconfig.exclude).toBeDefined()
    expect(tsconfig.exclude).toContain('scripts')
  })

  it('verifies .gitignore contains lint_out.txt and generated output patterns', () => {
    const gitignorePath = path.join(rootDir, '.gitignore')
    const gitignore = fs.readFileSync(gitignorePath, 'utf8')

    expect(gitignore).toContain('lint_out.txt')
  })

  it('verifies eslint.config.mjs ignores the scripts directory', () => {
    const eslintConfigPath = path.join(rootDir, 'eslint.config.mjs')
    const eslintConfig = fs.readFileSync(eslintConfigPath, 'utf8')

    expect(eslintConfig).toContain('scripts/**')
  })
})
