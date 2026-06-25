import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireScope, RoutesBForbiddenError } from '../../../_lib/authz'
import { errorResponse } from '../../../_lib/errors'
import { z } from 'zod'

const UploadEvidenceSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileType: z.string().min(1).max(100),
  fileSize: z.number().int().positive().max(10 * 1024 * 1024), // 10MB max
  fileUrl: z.string().url().max(2048),
  description: z.string().max(2000).optional(),
})

async function POSTHandler(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireScope(request, 'routes-b:read')

    const { id } = await context.params

    const parsedId = z.string().uuid().safeParse(id)
    if (!parsedId.success) {
      return errorResponse('BAD_REQUEST', 'Invalid dispute ID format', {}, 400)
    }

    // Verify the dispute exists and belongs to the user
    const dispute = await prisma.dispute.findUnique({
      where: { id },
      include: {
        invoice: {
          select: { userId: true },
        },
      },
    })

    if (!dispute || dispute.invoice.userId !== auth.userId) {
      return errorResponse('NOT_FOUND', 'Dispute not found', {}, 404)
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('BAD_REQUEST', 'Invalid JSON body', {}, 400)
    }

    const parsed = UploadEvidenceSchema.safeParse(body)
    if (!parsed.success) {
      const fields: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.')
        fields[key] = issue.message
      }
      return errorResponse('BAD_REQUEST', 'Validation failed', { fields }, 400)
    }

    const { fileName, fileType, fileSize, fileUrl, description } = parsed.data

    // Create a dispute message with the evidence attachment
    const evidence = await prisma.disputeMessage.create({
      data: {
        disputeId: id,
        senderType: 'user',
        senderEmail: '', // Will be resolved from user
        message: description ?? `Evidence uploaded: ${fileName}`,
        attachments: [
          {
            fileName,
            fileType,
            fileSize,
            fileUrl,
            uploadedAt: new Date().toISOString(),
          },
        ],
      },
      select: {
        id: true,
        disputeId: true,
        message: true,
        attachments: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ evidence }, { status: 201 })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', {}, 401)
    }
    return errorResponse('INTERNAL', 'Failed to upload dispute evidence', {}, 500)
  }
}

export const POST = withRequestId(POSTHandler)