#!/usr/bin/env node
/**
 * Env drift check: fails when the codebase reads a process.env variable
 * (or prisma env(...) calls) that is not documented in .env.example.
 *
 * Platform-injected variables (CI, Vercel, Node) are whitelisted below.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const ENV_EXAMPLE = join(ROOT, '.env.example')

const SCAN_DIRS = ['app', 'lib', 'components', 'hooks', 'middleware.ts', 'scripts', 'prisma']
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.prisma'])

// Variables injected by the platform/runtime — never belong in .env.example.
const PLATFORM_VARS = new Set([
  'CI',
  'NODE_ENV',
  'NEXT_RUNTIME',
  'NEXT_PHASE',
  'npm_lifecycle_event',
  'npm_package_name',
  'npm_package_version',
  'VERCEL',
  'VERCEL_ENV',
  'VERCEL_URL',
  'VERCEL_REGION',
  'VERCEL_PROJECT_PRODUCTION_URL',
  'VERCEL_GIT_COMMIT_SHA',
  'VERCEL_GIT_COMMIT_REF',
  'VERCEL_GIT_REPO_OWNER',
  'VERCEL_GIT_REPO_SLUG',
  'VERCEL_GIT_PULL_REQUEST_ID',
])

function* walk(path) {
  const stat = statSync(path)
  if (stat.isFile()) {
    yield path
    return
  }
  for (const entry of readdirSync(path)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    yield* walk(join(path, entry))
  }
}

function collectFiles() {
  const files = []
  for (const entry of SCAN_DIRS) {
    const full = join(ROOT, entry)
    try {
      const stat = statSync(full)
      if (stat.isFile()) {
        if (SCAN_EXTENSIONS.has(full.slice(full.lastIndexOf('.')))) files.push(full)
      } else if (stat.isDirectory()) {
        for (const file of walk(full)) {
          const ext = file.slice(file.lastIndexOf('.'))
          if (SCAN_EXTENSIONS.has(ext)) files.push(file)
        }
      }
    } catch {
      // missing optional dir — skip
    }
  }
  return files
}

function parseEnvExample() {
  const keys = new Set()
  for (const line of readFileSync(ENV_EXAMPLE, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/)
    if (match) keys.add(match[1])
  }
  return keys
}

const ENV_READ_PATTERNS = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g,
  /\benv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\)/g, // prisma schema env(...)
]

const used = new Map() // var -> Set<file>
for (const file of collectFiles()) {
  const content = readFileSync(file, 'utf8')
  for (const pattern of ENV_READ_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1]
      if (PLATFORM_VARS.has(name)) continue
      if (!used.has(name)) used.set(name, new Set())
      used.get(name).add(relative(ROOT, file))
    }
  }
}

const documented = parseEnvExample()
const missing = [...used.keys()].filter((name) => !documented.has(name)).sort()

if (missing.length === 0) {
  console.log(`Env drift check passed: ${used.size} env vars read, all documented in .env.example`)
  process.exit(0)
}

console.error(`Env drift detected: ${missing.length} env var(s) read in code but missing from .env.example:\n`)
for (const name of missing) {
  const files = [...used.get(name)].slice(0, 3).join(', ')
  console.error(`  - ${name}  (e.g. ${files})`)
}
console.error('\nAdd them to .env.example or whitelist platform vars in scripts/check-env-drift.mjs')
process.exit(1)
