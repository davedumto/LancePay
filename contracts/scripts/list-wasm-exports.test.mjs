import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findDuplicateExports, INTERNAL_EXPORTS } from './check-wasm-exports.mjs'
import { parseWasmExports } from './list-wasm-exports.mjs'

function leb(value) {
  const bytes = []
  do {
    let byte = value & 0x7f
    value >>>= 7
    if (value) byte |= 0x80
    bytes.push(byte)
  } while (value)
  return bytes
}

function wasmWithExports(entries) {
  const encoder = new TextEncoder()
  const exports = []
  for (const [name, kind] of entries) {
    const encoded = encoder.encode(name)
    exports.push(...leb(encoded.length), ...encoded, kind, ...leb(0))
  }
  const count = leb(entries.length)
  const section = [7, ...leb(count.length + exports.length), ...count, ...exports]
  return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...section])
}

describe('parseWasmExports', () => {
  it('lists function exports and ignores non-function exports', () => {
    const bytes = wasmWithExports([
      ['init', 0],
      ['memory', 2],
      ['status', 0],
      ['_', 0],
    ])
    assert.deepEqual(parseWasmExports(bytes), ['init', 'status', '_'])
  })

  it('rejects a buffer that is not a WASM module', () => {
    assert.throws(() => parseWasmExports(Uint8Array.from([1, 2, 3, 4])), /Not a WASM module/)
  })
})

describe('findDuplicateExports', () => {
  it('detects the collision that the crate split prevents', () => {
    const duplicates = findDuplicateExports([
      { crate: 'milestone_escrow', functions: ['init', 'status', '_'] },
      { crate: 'sep10_authenticator', functions: ['init', 'verify_challenge', '_'] },
    ])
    assert.deepEqual(duplicates, [{ name: 'init', crates: ['milestone_escrow', 'sep10_authenticator'] }])
  })

  it('ignores Soroban internal exports', () => {
    assert.equal(INTERNAL_EXPORTS.has('_'), true)
    assert.deepEqual(
      findDuplicateExports([
        { crate: 'a', functions: ['_'] },
        { crate: 'b', functions: ['_'] },
      ]),
      [],
    )
  })
})
