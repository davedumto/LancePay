/**
 * Simple CSV parser for import (no external dependencies).
 */

export interface CsvImportOptions {
  maxSizeBytes?: number
  maxRows?: number
  requiredColumns?: string[]
}

export interface CsvRow {
  [key: string]: string
}

/**
 * Parse CSV line with proper handling of quoted fields.
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  let i = 0

  while (i < line.length) {
    const char = line[i]

    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        // Escaped quote inside quotes
        current += '"'
        i += 2
      } else {
        // Start or end quotes
        inQuotes = !inQuotes
        i++
      }
    } else if (char === ',' && !inQuotes) {
      // End of field
      result.push(current.trim())
      current = ''
      i++
    } else {
      current += char
      i++
    }
  }

  // Add last field
  result.push(current.trim())
  return result
}

/**
 * Stream-parse CSV data with size limits.
 */
export async function* parseCsvStream(
  stream: ReadableStream<Uint8Array>,
  options: CsvImportOptions = {}
): AsyncGenerator<CsvRow, void, unknown> {
  const {
    maxSizeBytes = 2 * 1024 * 1024, // 2 MiB default
    maxRows = 10000,
    requiredColumns = []
  } = options

  const reader = stream.getReader()
  let bytesRead = 0
  let rowsProcessed = 0
  let buffer = ''
  let headers: string[] = []
  let headersChecked = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      // Check size limit
      bytesRead += value.length
      if (bytesRead > maxSizeBytes) {
        throw new Error(`CSV size exceeds limit of ${maxSizeBytes} bytes`)
      }

      // Decode and add to buffer
      buffer += new TextDecoder().decode(value)
      
      // Process complete lines
      const lines = buffer.split('\n')
      buffer = lines.pop() || '' // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim() === '') continue // Skip empty lines

        if (!headersChecked) {
          // First non-empty line is headers
          headers = parseCsvLine(line)
          
          // Validate required columns
          const missingColumns = requiredColumns.filter(col => !headers.includes(col))
          if (missingColumns.length > 0) {
            throw new Error(`Missing required columns: ${missingColumns.join(', ')}`)
          }
          
          headersChecked = true
          continue
        }

        // Parse data row
        const values = parseCsvLine(line)
        const row: CsvRow = {}
        
        headers.forEach((header, index) => {
          row[header] = values[index] || ''
        })

        rowsProcessed++
        if (rowsProcessed > maxRows) {
          throw new Error(`CSV exceeds maximum of ${maxRows} rows`)
        }

        yield row
      }
    }

    // Process any remaining data in buffer
    if (buffer.trim() && headersChecked) {
      const values = parseCsvLine(buffer)
      const row: CsvRow = {}
      
      headers.forEach((header, index) => {
        row[header] = values[index] || ''
      })

      yield row
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Parse CSV from text string (for testing).
 */
export async function parseCsvText(
  text: string,
  options: CsvImportOptions = {}
): Promise<CsvRow[]> {
  const rows: CsvRow[] = []
  
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    }
  })

  for await (const row of parseCsvStream(stream, options)) {
    rows.push(row)
  }

  return rows
}