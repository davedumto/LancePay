import { withRequestId } from '../../../_lib/with-request-id'
import { withMethods } from '../../../_lib/with-methods'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getCreditNoteById } from '../../../_lib/credit-notes'
import { streamPDF, type PDFSpec } from '../../../_lib/pdf'

export const runtime = 'nodejs'

async function GETHandler(
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

    const pdfSpec: PDFSpec = {
      title: `Credit Note ${note.number}`,
      filename: `credit-note-${note.number}.pdf`,
      sections: [
        {
          title: 'Issued To',
          content: user.name || user.email || '',
        },
        {
          title: 'Invoice Ref',
          content: note.invoiceId,
        },
        {
          title: 'Amount',
          content: `${note.amount} ${note.currency}`,
        },
        {
          title: 'Reason',
          content: note.reason,
        },
        {
          title: 'Date',
          content: new Date(note.issuedAt).toLocaleDateString(),
        },
      ],
    }

    return streamPDF(pdfSpec)
  } catch (error) {
    return NextResponse.json({ error: 'Failed to generate PDF' }, { status: 500 })
  }
}

export const { GET } = withMethods({
  GET: withRequestId(GETHandler),
})