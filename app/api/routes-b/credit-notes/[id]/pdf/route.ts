import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { renderToStream } from '@react-pdf/renderer'
import { getCreditNoteById } from '../../_lib/credit-notes'
import { CreditNotePDF } from '../../_lib/CreditNotePDF'
import React from 'react'

export const runtime = 'nodejs'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const note = await getCreditNoteById(user.id, id)
    if (!note) return NextResponse.json({ error: 'Credit note not found' }, { status: 404 })

    const stream = await renderToStream(
      React.createElement(CreditNotePDF, { note, user })
    )

    return new NextResponse(stream as unknown as ReadableStream, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="credit-note-${note.number}.pdf"`,
      },
    })
  } catch (error) {
    return NextResponse.json({ error: 'Failed to generate PDF' }, { status: 500 })
  }
}
