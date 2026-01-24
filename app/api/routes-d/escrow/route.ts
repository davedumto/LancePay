import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({
    ok: true,
    routes: {
      escrow: {
        enable: '/api/routes-d/escrow/enable',
        release: '/api/routes-d/escrow/release',
        dispute: '/api/routes-d/escrow/dispute',
        status: '/api/routes-d/escrow/status?invoiceId={id}',
      },
    },
  })
}

