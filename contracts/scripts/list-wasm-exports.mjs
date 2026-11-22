#!/usr/bin/env node
// Lists the function exports of a WASM module by reading its export section.
// No external tooling is required, so this can run in CI with only Node.

import { readFileSync } from 'node:fs'

const MAGIC = [0x00, 0x61, 0x73, 0x6d]
const FUNCTION_EXPORT = 0x00

function readU32(bytes, offset) {
  let value = 0
  let shift = 0
  let index = offset
  for (;;) {
    if (index >= bytes.length || shift > 28) throw new Error('Malformed LEB128 value')
    const byte = bytes[index++]
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value, next: index }
    shift += 7
  }
}

export function parseWasmExports(bytes) {
  if (bytes.length < 8 || MAGIC.some((byte, index) => bytes[index] !== byte)) {
    throw new Error('Not a WASM module')
  }

  const exports = []
  let offset = 8
  while (offset < bytes.length) {
    const sectionId = bytes[offset++]
    const section = readU32(bytes, offset)
    offset = section.next
    const sectionEnd = offset + section.value
    if (sectionEnd > bytes.length) throw new Error('Malformed WASM section length')

    if (sectionId === 7) {
      const count = readU32(bytes, offset)
      offset = count.next
      for (let i = 0; i < count.value; i++) {
        const nameLength = readU32(bytes, offset)
        offset = nameLength.next
        const name = new TextDecoder().decode(bytes.subarray(offset, offset + nameLength.value))
        offset += nameLength.value
        const kind = bytes[offset++]
        const index = readU32(bytes, offset)
        offset = index.next
        if (kind === FUNCTION_EXPORT) exports.push(name)
      }
    }

    offset = sectionEnd
  }
  return exports
}

function main() {
  const file = process.argv[2]
  if (!file) {
    console.error('Usage: node list-wasm-exports.mjs <file.wasm>')
    process.exitCode = 1
    return
  }
  for (const name of parseWasmExports(readFileSync(file))) console.log(name)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main()
}
