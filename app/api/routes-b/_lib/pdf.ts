import { NextResponse } from 'next/server'
import React from 'react'

export type PDFSection = {
  title?: string
  content?: string
}

export type PDFTableRow = Record<string, string | number | null | undefined>

export type PDFTable = {
  headers: string[]
  rows: PDFTableRow[]
}

export type PDFSpec = {
  title: string
  sections?: PDFSection[]
  table?: PDFTable
  filename?: string
}

export async function streamPDF(spec: PDFSpec): Promise<NextResponse> {
  const { title, sections = [], table, filename } = spec

  const ReactPDF = await import('@react-pdf/renderer')
  const Document = ReactPDF.Document as any
  const Page = ReactPDF.Page as any
  const Text = ReactPDF.Text as any
  const View = ReactPDF.View as any
  const StyleSheet = ReactPDF.StyleSheet as any
  const renderToStream = ReactPDF.renderToStream as any

  const styles = StyleSheet.create({
    page: {
      padding: 30,
      fontSize: 12,
    },
    title: {
      fontSize: 20,
      marginBottom: 20,
      fontWeight: 'bold',
    },
    section: {
      margin: 10,
      padding: 10,
    },
    sectionTitle: {
      fontSize: 14,
      marginBottom: 5,
      fontWeight: 'bold',
    },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 5,
    },
    tableHeader: {
      flexDirection: 'row',
      backgroundColor: '#f0f0f0',
      padding: 5,
      fontWeight: 'bold',
    },
    tableRow: {
      flexDirection: 'row',
      padding: 5,
      borderBottom: '1pt solid #ddd',
    },
    tableCell: {
      flex: 1,
    },
  })

  const children: React.ReactNode[] = [
    React.createElement(Text, { key: 'title', style: styles.title }, title),
  ]

  sections.forEach((section, idx) => {
    const sectionChildren: React.ReactNode[] = []
    if (section.title) {
      sectionChildren.push(
        React.createElement(Text, { key: 'stitle', style: styles.sectionTitle }, section.title)
      )
    }
    if (section.content) {
      sectionChildren.push(
        React.createElement(Text, { key: 'scontent' }, section.content)
      )
    }
    children.push(
      React.createElement(View, { key: `section-${idx}`, style: styles.section }, sectionChildren)
    )
  })

  if (table) {
    const headerCells = table.headers.map((header, idx) =>
      React.createElement(Text, { key: idx, style: styles.tableCell }, header)
    )
    children.push(
      React.createElement(View, { key: 'thead', style: styles.tableHeader }, headerCells)
    )

    table.rows.forEach((row, rowIdx) => {
      const rowCells = table.headers.map((header, cellIdx) =>
        React.createElement(Text, { key: cellIdx, style: styles.tableCell }, 
          String(row[header] ?? '')
        )
      )
      children.push(
        React.createElement(View, { key: `row-${rowIdx}`, style: styles.tableRow }, rowCells)
      )
    })
  }

  const pdfElement = React.createElement(Document, null,
    React.createElement(Page, { size: 'A4', style: styles.page }, children)
  )

  const stream = await renderToStream(pdfElement)

  const headers: Record<string, string> = {
    'Content-Type': 'application/pdf',
  }
  if (filename) {
    headers['Content-Disposition'] = `attachment; filename="${filename}"`
  }

  return new NextResponse(stream as unknown as ReadableStream, { headers })
}