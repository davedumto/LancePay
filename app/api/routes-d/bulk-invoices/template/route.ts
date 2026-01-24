import { NextResponse } from 'next/server'

export async function GET() {
  const csv = [
    'clientEmail,clientName,description,amount,dueDate,sendEmail',
    'example@client.com,Client Name,Service description,100.00,2026-02-01,true',
  ].join('\n')

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="bulk-invoices-template.csv"',
      'Cache-Control': 'no-store',
    },
  })
}

