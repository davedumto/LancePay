import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function findFiles(dir: string, extensions: string[]): string[] {
  let results: string[] = []
  if (!fs.existsSync(dir)) return results

  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.next' && entry.name !== '.git') {
        results = results.concat(findFiles(fullPath, extensions))
      }
    } else if (entry.isFile()) {
      if (extensions.some(ext => entry.name.endsWith(ext))) {
        results.push(fullPath)
      }
    }
  }
  return results
}

describe('Auth dependency audit', () => {
  it('confirms no route, lib, or component file imports next-auth', () => {
    const rootDir = path.resolve(__dirname, '..')
    const targetDirs = ['app', 'lib', 'modules', 'components']

    const filesToCheck: string[] = []
    for (const dir of targetDirs) {
      filesToCheck.push(...findFiles(path.join(rootDir, dir), ['.ts', '.tsx', '.js', '.jsx']))
    }

    const offendingFiles: { file: string; match: string }[] = []

    for (const file of filesToCheck) {
      const content = fs.readFileSync(file, 'utf8')
      const lines = content.split('\n')
      lines.forEach((line, index) => {
        if (/from ['"]next-auth['"]|require\(['"]next-auth['"]\)|import ['"]next-auth['"]/.test(line)) {
          offendingFiles.push({
            file: path.relative(rootDir, file),
            match: `Line ${index + 1}: ${line.trim()}`,
          })
        }
      })
    }

    expect(offendingFiles).toEqual([])
  })

  it('confirms next-auth is not in package.json dependencies or devDependencies', () => {
    const packageJsonPath = path.resolve(__dirname, '../package.json')
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))

    expect(pkg.dependencies?.['next-auth']).toBeUndefined()
    expect(pkg.devDependencies?.['next-auth']).toBeUndefined()
  })
})
