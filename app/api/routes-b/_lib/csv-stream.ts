const encoder = new TextEncoder()

export type CsvValue = string | number | boolean | Date | null | undefined

export type CsvColumn<T> = {
  header: string
  value: (row: T) => CsvValue
}

export type CsvBatchFetcher<T> = (cursor: string | null, batchSize: number) => Promise<T[]>

export const CSV_BATCH_SIZE = 500

export function escapeCsvCell(value: CsvValue): string {
  const text = value instanceof Date ? value.toISOString() : String(value ?? '')

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }

  return text
}

export function createCsvStream<T extends { id: string }>(
  columns: CsvColumn<T>[],
  fetchBatch: CsvBatchFetcher<T>,
  batchSize = CSV_BATCH_SIZE,
): ReadableStream<Uint8Array> {
  let cursor: string | null = null
  let sentHeader = false
  let done = false

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentHeader) {
        sentHeader = true
        controller.enqueue(encoder.encode(`${columns.map(column => escapeCsvCell(column.header)).join(',')}\n`))
        return
      }

      if (done) {
        controller.close()
        return
      }

      const rows = await fetchBatch(cursor, batchSize)

      if (rows.length === 0) {
        done = true
        controller.close()
        return
      }

      cursor = rows[rows.length - 1].id
      const csvRows = rows
        .map(row => columns.map(column => escapeCsvCell(column.value(row))).join(','))
        .join('\n')

      controller.enqueue(encoder.encode(`${csvRows}\n`))

      if (rows.length < batchSize) {
        done = true
      }
    },
  })
}
