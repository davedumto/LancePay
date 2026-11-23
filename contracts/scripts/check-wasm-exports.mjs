#!/usr/bin/env node
// Lists the function exports of every contract WASM and fails if two crates
// export the same function name. Soroban's internal `_` export is ignored.

import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseWasmExports } from './list-wasm-exports.mjs'

export const INTERNAL_EXPORTS = new Set(['_'])

export const EXPECTED_CRATES = [
  'dispute_resolution',
  'gasless_handler',
  'liquidity_rebalancer',
  'milestone_escrow',
  'multisig_governance',
  'path_payment',
  'sep10_authenticator',
  'transaction_monitor',
  'trustline_handler',
  'upgrade_handler',
]

export function collectWasmExports(directory) {
  return readdirSync(directory)
    .filter((file) => file.endsWith('.wasm'))
    .sort()
    .map((file) => ({
      crate: basename(file, '.wasm'),
      functions: parseWasmExports(readFileSync(join(directory, file))),
    }))
}

export function findDuplicateExports(entries) {
  const owners = new Map()
  for (const { crate, functions } of entries) {
    for (const name of functions) {
      if (INTERNAL_EXPORTS.has(name)) continue
      const crates = owners.get(name) ?? []
      crates.push(crate)
      owners.set(name, crates)
    }
  }
  return [...owners]
    .filter(([, crates]) => crates.length > 1)
    .map(([name, crates]) => ({ name, crates }))
}

function main() {
  const directory = process.argv[2] ?? 'target/wasm32-unknown-unknown/release'
  const entries = collectWasmExports(directory)
  for (const { crate, functions } of entries) {
    console.log(`${crate}: ${functions.join(', ')}`)
  }

  const found = new Set(entries.map((entry) => entry.crate))
  const missing = EXPECTED_CRATES.filter((crate) => !found.has(crate))
  const duplicates = findDuplicateExports(entries)

  if (missing.length > 0) {
    console.error(`Missing contract WASM(s): ${missing.join(', ')}`)
    process.exitCode = 1
  }
  if (duplicates.length > 0) {
    for (const duplicate of duplicates) {
      console.error(
        `Duplicate export ${duplicate.name}: ${duplicate.crates.join(', ')}`,
      )
    }
    process.exitCode = 1
  }
  if (!process.exitCode) console.log('All contract WASMs have unique function exports.')
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main()
}
