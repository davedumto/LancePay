import { describe, it, expect, vi } from 'vitest'
import { streamPDF } from '../pdf'

vi.mock('@react-pdf/renderer', () => ({
  renderToStream: vi.fn().mockResolvedValue(new ReadableStream()),
  Document: ({ children }: any) => null,
  Page: ({ children }: any) => null,
  Text: ({ children }: any) => null,
  View: ({ children }: any) => null,
  StyleSheet: {
    create: vi.fn().mockReturnValue({}),
  },
}))

describe('pdf', () => {
  it('streams PDF response with basic content', async () => {
    const spec = {
      title: 'Test PDF',
      sections: [
        { title: 'Section 1', content: 'Content 1' },
      ],
    }

    const response = await streamPDF(spec)

    expect(response).toBeInstanceOf(Response)
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
  })

  it('renders special characters correctly', async () => {
    const spec = {
      title: 'Test & Special <Characters>',
      sections: [
        { content: 'Unicode: 你好世界 🎉 <>&"\'' },
      ],
    }

    const response = await streamPDF(spec)

    expect(response.headers.get('Content-Type')).toBe('application/pdf')
  })

  it('includes filename in Content-Disposition when provided', async () => {
    const spec = {
      title: 'Test PDF',
      filename: 'test-file.pdf',
    }

    const response = await streamPDF(spec)

    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="test-file.pdf"')
  })

  it('handles table data', async () => {
    const spec = {
      title: 'Table PDF',
      table: {
        headers: ['Name', 'Amount'],
        rows: [
          { Name: 'Item 1', Amount: '100' },
          { Name: 'Item 2', Amount: '200' },
        ],
      },
    }

    const response = await streamPDF(spec)

    expect(response.headers.get('Content-Type')).toBe('application/pdf')
  })
})