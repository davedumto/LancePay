import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({
    ok: true,
    routes: {
      verification: {
        clientCheck: '/api/routes-d/verification/client-check?email={email}',
      },
    },
  })
}
