import { withRequestId } from '../../../_lib/with-request-id'
import { withMethods } from '../../../_lib/with-methods'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { errorResponse } from '../../../_lib/errors'
import { logger } from '@/lib/logger'
import { z } from 'zod'

const invoiceIdParamsSchema = z.object({
  id: z.string().uuid('Invoice id must be a valid UUID'),
})

const createMessageSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, 'Content is required')
    .max(1000, 'Content must be 1000 characters or fewer'),
})

function messageValidationFields(error: z.ZodError) {
  const fields = error.flatten().fieldErrors
  return {
    ...(fields.content ? { content: fields.content } : {}),
  }
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return { error: errorResponse('UNAUTHORIZED', 'Unauthorized', undefined, 401) }
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return { error: errorResponse('UNAUTHORIZED', 'Unauthorized', undefined, 401) }
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, name: true, email: true },
  })

  if (!user) {
    return { error: errorResponse('NOT_FOUND', 'User not found', undefined, 404) }
  }

  return { user }
}

async function authorizeInvoiceAccess(request: NextRequest, id: string) {
  const parsedParams = invoiceIdParamsSchema.safeParse({ id })
  if (!parsedParams.success) {
    return {
      error: errorResponse(
        'BAD_REQUEST',
        'Invalid invoice id',
        { fields: { id: 'Must be a valid UUID' } },
        400,
      ),
    }
  }

  const auth = await getAuthenticatedUser(request)
  if ('error' in auth) return auth

  const invoice = await prisma.invoice.findUnique({
    where: { id: parsedParams.data.id },
    select: { id: true, userId: true },
  })

  if (!invoice || invoice.userId !== auth.user.id) {
    return { error: errorResponse('NOT_FOUND', 'Invoice not found', undefined, 404) }
  }

  return { user: auth.user, invoice }
}

async function GETHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const auth = await authorizeInvoiceAccess(request, id)
    if ('error' in auth) return auth.error

    const messages = await prisma.invoiceMessage.findMany({
      where: { invoiceId: auth.invoice.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        invoiceId: true,
        senderId: true,
        senderType: true,
        senderName: true,
        content: true,
        attachmentUrl: true,
        isInternal: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ messages })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/invoices/[id]/messages error')
    return errorResponse('INTERNAL', 'Failed to list invoice messages', undefined, 500)
  }
}

async function POSTHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const auth = await authorizeInvoiceAccess(request, id)
    if ('error' in auth) return auth.error

    const body = await request.json().catch(() => null)
    if (!body) {
      return errorResponse('BAD_REQUEST', 'Invalid JSON body', undefined, 400)
    }

    const parsedBody = createMessageSchema.safeParse(body)
    if (!parsedBody.success) {
      return errorResponse(
        'BAD_REQUEST',
        'Invalid message payload',
        {
          fields: messageValidationFields(parsedBody.error),
        },
        400,
      )
    }

    const message = await prisma.invoiceMessage.create({
      data: {
        invoiceId: auth.invoice.id,
        senderId: auth.user.id,
        senderType: 'freelancer',
        senderName: auth.user.name ?? auth.user.email,
        content: parsedBody.data.content,
      },
      select: {
        id: true,
        invoiceId: true,
        senderId: true,
        senderType: true,
        senderName: true,
        content: true,
        attachmentUrl: true,
        isInternal: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ message }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/invoices/[id]/messages error')
    return errorResponse('INTERNAL', 'Failed to create invoice message', undefined, 500)
  }
}

export const { GET, POST } = withMethods({
  GET: withRequestId(GETHandler),
  POST: withRequestId(POSTHandler),
})
