import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('Vitest Include Globs Guard', () => {
  const rootDir = path.resolve(__dirname, '..')
  const vitestConfigPath = path.join(rootDir, 'vitest.config.ts')

  it('includes lib test files in vitest.config.ts include globs', () => {
    expect(fs.existsSync(vitestConfigPath)).toBe(true)
    const configContent = fs.readFileSync(vitestConfigPath, 'utf8')
    
    // Must include lib test glob
    expect(configContent).toMatch(/['"]lib\/\*\*\/\*\.test\.ts['"]/)
  })

  it('verifies that all test files in lib/ are covered by include globs', () => {
    const libDir = path.join(rootDir, 'lib')
    if (!fs.existsSync(libDir)) return

    const getTestFiles = (dir: string): string[] => {
      let results: string[] = []
      const list = fs.readdirSync(dir)
      for (const file of list) {
        const filePath = path.join(dir, file)
        const stat = fs.statSync(filePath)
        if (stat.isDirectory()) {
          results = results.concat(getTestFiles(filePath))
        } else if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) {
          results.push(path.relative(rootDir, filePath))
        }
      }
      return results
    }

    const libTestFiles = getTestFiles(libDir)
    expect(libTestFiles.length).toBeGreaterThan(0)

    const configContent = fs.readFileSync(vitestConfigPath, 'utf8')
    for (const testFile of libTestFiles) {
      // Must start with lib/ and end with .test.ts
      expect(testFile.startsWith('lib/')).toBe(true)
      expect(configContent.includes('lib/**/*.test.ts')).toBe(true)
    }
  })
})
