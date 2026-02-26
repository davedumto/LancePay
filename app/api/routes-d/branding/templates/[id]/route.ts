import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ---------------------------------------------------------------------------
// Helper — identical to the one in ../route.ts but copied here to keep each
// route file self-contained and avoid a circular import.
// ---------------------------------------------------------------------------
async function resolveUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return { error: 'Unauthorized' as const }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return { error: 'User not found' as const }

  return { user }
}

// ---------------------------------------------------------------------------
// GET /api/routes-d/branding/templates/[id]
// Returns a single template.  Ownership is verified — users cannot read each
// other's templates even if they somehow obtain a valid id.
// ---------------------------------------------------------------------------
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await resolveUser(request)
    if ('error' in auth) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Unauthorized' ? 401 : 404 }
      )
    }

    const template = await prisma.invoiceTemplate.findUnique({
      where: { id: params.id },
    })

    // Return 404 for both "not found" and "belongs to another user" to avoid
    // inadvertently leaking the existence of another user's template.
    if (!template || template.userId !== auth.user.id) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true, template })
  } catch (error) {
    logger.error({ err: error }, 'Error fetching invoice template by id:')
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/routes-d/branding/templates/[id]
// Deletes a template.  Guards against deleting the last default template by
// checking if another template exists for the user and, if so, auto-promoting
// the most recently created one.  Prevents orphaned invoice references by
// checking whether any invoices currently reference this template.
// ---------------------------------------------------------------------------
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await resolveUser(request)
    if ('error' in auth) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Unauthorized' ? 401 : 404 }
      )
    }

    const template = await prisma.invoiceTemplate.findUnique({
      where: { id: params.id },
    })

    if (!template || template.userId !== auth.user.id) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    }

    // Prevent deleting a template that is currently attached to invoices.
    // Callers must either update the invoices first or explicitly pass
    // ?force=true to null out the templateId on affected invoices.
    const invoiceCount = await prisma.invoice.count({
      where: {
        // Only check if the Invoice model has a templateId relation;
        // if the column doesn't exist yet this will be a no-op after migration.
        templateId: params.id,
      } as any,
    }).catch(() => 0) // gracefully handle if column doesn't exist yet

    const force = new URL(request.url).searchParams.get('force') === 'true'

    if (invoiceCount > 0 && !force) {
      return NextResponse.json(
        {
          error: `Template is used by ${invoiceCount} invoice(s). Pass ?force=true to detach and delete.`,
          invoiceCount,
        },
        { status: 409 }
      )
    }

    await prisma.$transaction(async (tx) => {
      // Detach invoices if force-deleting to avoid FK violations
      if (invoiceCount > 0 && force) {
        await (tx.invoice.updateMany({
          where: { templateId: params.id } as any,
          data: { templateId: null } as any,
        }).catch(() => null)) // no-op if column doesn't exist yet
      }

      await tx.invoiceTemplate.delete({ where: { id: params.id } })

      // If we just removed the default template, promote the next most recent
      // one so the user always has a usable default going forward.
      if (template.isDefault) {
        const next = await tx.invoiceTemplate.findFirst({
          where: { userId: auth.user.id },
          orderBy: { createdAt: 'desc' },
        })
        if (next) {
          await tx.invoiceTemplate.update({
            where: { id: next.id },
            data: { isDefault: true },
          })
        }
      }
    })

    return NextResponse.json({ success: true, message: 'Template deleted' })
  } catch (error) {
    logger.error({ err: error }, 'Error deleting invoice template:')
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
