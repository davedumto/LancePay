import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('CI Workflow Environment Validation (#1896)', () => {
  const ciWorkflowPath = path.resolve(__dirname, '../.github/workflows/ci.yml')

  it('ensures CI workflow file exists', () => {
    expect(fs.existsSync(ciWorkflowPath)).toBe(true)
  })

  it('removes unused Clerk secrets from the build step', () => {
    const content = fs.readFileSync(ciWorkflowPath, 'utf8')
    expect(content).not.toContain('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY')
    expect(content).not.toContain('CLERK_SECRET_KEY')
  })

  it('does not inject production secrets.DATABASE_URL into the build step and uses a dummy placeholder', () => {
    const content = fs.readFileSync(ciWorkflowPath, 'utf8')
    expect(content).not.toContain('${{ secrets.DATABASE_URL }}')
    expect(content).toMatch(/DATABASE_URL:\s*["']postgresql:\/\/dummy:dummy@localhost:5432\/dummy/)
  })

  it('supplies build-time placeholder values for Privy variables', () => {
    const content = fs.readFileSync(ciWorkflowPath, 'utf8')
    expect(content).toMatch(/NEXT_PUBLIC_PRIVY_APP_ID:\s*["'][^"']+["']/)
    expect(content).toMatch(/PRIVY_APP_SECRET:\s*["'][^"']+["']/)
  })

  it('includes explanatory comments documenting build-time environment variables', () => {
    const content = fs.readFileSync(ciWorkflowPath, 'utf8')
    expect(content).toContain('# Build-time environment variables:')
    expect(content).toContain('NEXT_PUBLIC_PRIVY_APP_ID')
    expect(content).toContain('DATABASE_URL')
  })
})
