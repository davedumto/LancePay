import { withRequestId } from '../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireScope, RoutesBForbiddenError } from '../_lib/authz'
import { errorResponse } from '../_lib/errors'
import { z } from 'zod'

const UpdateSequenceSchema = z.object({
  prefix: z
    .string()
    .max(20, 'Prefix must be at most 20 characters')
    .optional(),
  nextNumber: z
    .number()
    .int('Next number must be an integer')
    .positive('Next number must be positive')
    .optional(),
  format: z
    .string()
    .max(100, 'Format must be at most 100 characters')
    .optional(),
})

/**
 * Get the user's invoice number sequence configuration.
 */
async function GETHandler(request: NextRequest) {
  try {
    const auth = await requireScope(request, 'routes-b:read')

    // Try to find existing sequence configuration
    // Since the schema doesn't have an InvoiceNumberSequence model,
    // we'll return a default configuration or check if one exists in a hypothetical table
    
    // For now, return default configuration
    // In a real implementation, this would query:
    // const sequence = await prisma.invoiceNumberSequence.findUnique({
    //   where: { userId: auth.userId },
    // })

    const defaultSequence = {
      userId: auth.userId,
      prefix: 'INV-',
      nextNumber: 1001,
      format: '{prefix}{year}-{number}',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    return NextResponse.json({ sequence: defaultSequence })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', {}, 401)
    }
    return errorResponse('INTERNAL', 'Failed to retrieve sequence configuration', {}, 500)
  }
}

/**
 * Update the user's invoice number sequence configuration.
 */
async function PATCHHandler(request: NextRequest) {
  try {
    const auth = await requireScope(request, 'routes-b:read')

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('BAD_REQUEST', 'Invalid JSON body', {}, 400)
    }

    const parsed = UpdateSequenceSchema.safeParse(body)
    if (!parsed.success) {
      const fields: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.')
        fields[key] = issue.message
      }
      return errorResponse('BAD_REQUEST', 'Validation failed', { fields }, 400)
    }

    const updates = parsed.data

    // Validate that at least one field is being updated
    if (Object.keys(updates).length === 0) {
      return errorResponse(
        'BAD_REQUEST',
        'At least one field must be provided for update',
        {},
        400
      )
    }

    // Validate format string if provided
    if (updates.format) {
      const validPlaceholders = ['{prefix}', '{year}', '{month}', '{number}']
      const hasValidPlaceholder = validPlaceholders.some(placeholder =>
        updates.format!.includes(placeholder)
      )
      
      if (!hasValidPlaceholder) {
        return errorResponse(
          'BAD_REQUEST',
          'Format must contain at least one valid placeholder: {prefix}, {year}, {month}, or {number}',
          { providedFormat: updates.format },
          400
        )
      }
    }

    // In a real implementation, this would upsert the configuration:
    // const sequence = await prisma.invoiceNumberSequence.upsert({
    //   where: { userId: auth.userId },
    //   update: {
    //     ...updates,
    //     updatedAt: new Date(),
    //   },
    //   create: {
    //     userId: auth.userId,
    //     prefix: updates.prefix ?? 'INV-',
    //     nextNumber: updates.nextNumber ?? 1001,
    //     format: updates.format ?? '{prefix}{year}-{number}',
    //   },
    // })

    // For now, return the updated configuration
    const updatedSequence = {
      userId: auth.userId,
      prefix: updates.prefix ?? 'INV-',
      nextNumber: updates.nextNumber ?? 1001,
      format: updates.format ?? '{prefix}{year}-{number}',
      updatedAt: new Date().toISOString(),
    }

    return NextResponse.json({ sequence: updatedSequence })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', {}, 401)
    }
    return errorResponse('INTERNAL', 'Failed to update sequence configuration', {}, 500)
  }
}

export const GET = GETHandler
export const PATCH = withRequestId(PATCHHandler)
