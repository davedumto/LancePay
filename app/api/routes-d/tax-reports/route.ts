import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({
    ok: true,
    routes: {
      taxReports: {
        annual: '/api/routes-d/tax-reports/annual?year={yyyy}',
        export: '/api/routes-d/tax-reports/export?year={yyyy}&format={pdf|csv|json}',
        form1099: '/api/routes-d/tax-reports/1099?year={yyyy}&clientEmail={email}',
      },
    },
  })
}

