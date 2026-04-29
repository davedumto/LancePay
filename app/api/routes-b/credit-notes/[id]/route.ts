import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getCreditNoteById, deleteCreditNote } from '../../_lib/credit-notes'
import { registerRoute } from '../../_lib/openapi'
import { z } from 'zod'

registerRoute({
  method: 'GET',
  path: '/credit-notes/{id}',
  summary: 'Get credit note',
  description: 'Get details of a specific credit note.',
  requestSchema: z.object({ id: z.string() }),
  responseSchema: z.object({
    id: z.string(),
    number: z.string(),
    amount: z.number()
  }),
  tags: ['credit-notes']
})

registerRoute({
  method: 'DELETE',
  path: '/credit-notes/{id}',
  summary: 'Delete credit note',
  description: 'Delete a specific credit note.',
  requestSchema: z.object({ id: z.string() }),
  responseSchema: z.object({ success: z.boolean() }),
  tags: ['credit-notes']
})

async function GETHandler(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const note = await getCreditNoteById(user.id, params.id)
    if (!note) return NextResponse.json({ error: 'Credit note not found' }, { status: 404 })

    return NextResponse.json(note)
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch credit note' }, { status: 500 })
  }
}

async function DELETEHandler(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const success = await deleteCreditNote(user.id, params.id)
    if (!success) return NextResponse.json({ error: 'Credit note not found' }, { status: 404 })

    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ error: 'Failed to delete credit note' }, { status: 500 })
  }
}

export const GET = withRequestId(GETHandler)
export const DELETE = withRequestId(DELETEHandler)
