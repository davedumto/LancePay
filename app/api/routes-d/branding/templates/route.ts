import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { z } from 'zod'
import { logger } from '@/lib/logger'

// Full template schema matching the InvoiceTemplate interface from the issue.
// We keep the branding-only PATCH/GET behaviour on the parent route (/api/routes-d/branding)
// and implement the full CRUD template system here at /api/routes-d/branding/templates.
const templateSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  isDefault: z.boolean().optional().default(false),

  // Branding fields — logoUrl is optional because users may not have uploaded a logo yet
  logoUrl: z.string().url('Must be a valid URL').optional().nullable(),
  primaryColor: z
    .string()
    .regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Invalid hex color')
    .default('#000000'),
  accentColor: z
    .string()
    .regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Invalid hex color')
    .default('#6366f1'),

  // Visibility toggles
  showLogo: z.boolean().default(true),
  showFooter: z.boolean().default(true),
  footerText: z.string().max(500).optional().nullable(),

  // Layout variant — constrained to the three options the UI will support
  layout: z.enum(['modern', 'classic', 'minimal']).default('modern'),
})

// Partial version used for PUT updates — every field becomes optional so callers
// can send only the fields they want to change (PATCH semantics via PUT body).
const templateUpdateSchema = templateSchema.partial().extend({
  // name still has the same constraints when provided
  name: z.string().min(1).max(100).optional(),
})

// ---------------------------------------------------------------------------
// Helper: resolve the "single default per user" invariant.
// When a template is being set as default we clear any existing default first
// so we never end up with two rows where isDefault=true for the same user.
// This is done inside the same transaction as the create/update to avoid a
// race condition between two concurrent requests.
// ---------------------------------------------------------------------------
async function clearExistingDefault(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  userId: string,
  excludeId?: string
) {
  await tx.invoiceTemplate.updateMany({
    where: {
      userId,
      isDefault: true,
      // Don't clear the row we are currently operating on
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
    data: { isDefault: false },
  })
}

// ---------------------------------------------------------------------------
// Helper: resolve the authenticated user from a request.
// Factored out so all four handlers share the same auth path.
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
// GET /api/routes-d/branding/templates
// Returns all templates owned by the authenticated user, default first.
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  try {
    const auth = await resolveUser(request)
    if ('error' in auth) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Unauthorized' ? 401 : 404 }
      )
    }

    const templates = await prisma.invoiceTemplate.findMany({
      where: { userId: auth.user.id },
      // Surface the default template first so the UI can easily pick it up
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    })

    return NextResponse.json({ success: true, templates })
  } catch (error) {
    logger.error({ err: error }, 'Error fetching invoice templates:')
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// ---------------------------------------------------------------------------
// POST /api/routes-d/branding/templates
// Creates a new template.  If isDefault=true, demotes any existing default.
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  try {
    const auth = await resolveUser(request)
    if ('error' in auth) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Unauthorized' ? 401 : 404 }
      )
    }

    const body = await request.json()
    const result = templateSchema.safeParse(body)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: result.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const data = result.data

    // Use a transaction so the default-flag update and the insert are atomic.
    // Without this, a race between two concurrent POST requests could leave
    // two templates marked as default.
    const template = await prisma.$transaction(async (tx) => {
      if (data.isDefault) {
        await clearExistingDefault(tx, auth.user.id)
      }

      return tx.invoiceTemplate.create({
        data: {
          userId: auth.user.id,
          name: data.name,
          isDefault: data.isDefault ?? false,
          logoUrl: data.logoUrl ?? null,
          primaryColor: data.primaryColor,
          accentColor: data.accentColor,
          showLogo: data.showLogo,
          showFooter: data.showFooter,
          footerText: data.footerText ?? null,
          layout: data.layout,
        },
      })
    })

    return NextResponse.json({ success: true, template }, { status: 201 })
  } catch (error) {
    // Prisma unique constraint violation — name already used by this user
    if (
      error instanceof Error &&
      'code' in (error as any) &&
      (error as any).code === 'P2002'
    ) {
      return NextResponse.json(
        { error: 'A template with that name already exists' },
        { status: 409 }
      )
    }
    logger.error({ err: error }, 'Error creating invoice template:')
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// ---------------------------------------------------------------------------
// PUT /api/routes-d/branding/templates
// Updates an existing template identified by ?id= query param.
// Keeping the handler in the base route file keeps the file count minimal;
// the [id] dynamic segment route could be added later for REST purity.
// ---------------------------------------------------------------------------
export async function PUT(request: NextRequest) {
  try {
    const auth = await resolveUser(request)
    if ('error' in auth) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Unauthorized' ? 401 : 404 }
      )
    }

    // Accept the template id either from the query string or the request body
    const { searchParams } = new URL(request.url)
    const body = await request.json()
    const templateId: string | null = searchParams.get('id') ?? body.id ?? null

    if (!templateId) {
      return NextResponse.json(
        { error: 'Template id is required (query param ?id= or body field id)' },
        { status: 400 }
      )
    }

    // Ownership check — prevent users from mutating each other's templates
    const existing = await prisma.invoiceTemplate.findUnique({
      where: { id: templateId },
      select: { userId: true },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    }

    if (existing.userId !== auth.user.id) {
      // Return 404 rather than 403 to avoid leaking that the resource exists
      return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    }

    // Remove 'id' from the payload before validation so it doesn't bleed into
    // the update data (id is immutable and not part of templateUpdateSchema)
    const { id: _ignored, ...updatePayload } = body
    const result = templateUpdateSchema.safeParse(updatePayload)
    if (!result.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: result.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const data = result.data

    const template = await prisma.$transaction(async (tx) => {
      // Only demote other defaults when the caller explicitly sets isDefault:true.
      // If the field is absent we leave the default flag untouched.
      if (data.isDefault === true) {
        await clearExistingDefault(tx, auth.user.id, templateId)
      }

      return tx.invoiceTemplate.update({
        where: { id: templateId },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.isDefault !== undefined && { isDefault: data.isDefault }),
          ...(data.logoUrl !== undefined && { logoUrl: data.logoUrl }),
          ...(data.primaryColor !== undefined && { primaryColor: data.primaryColor }),
          ...(data.accentColor !== undefined && { accentColor: data.accentColor }),
          ...(data.showLogo !== undefined && { showLogo: data.showLogo }),
          ...(data.showFooter !== undefined && { showFooter: data.showFooter }),
          ...(data.footerText !== undefined && { footerText: data.footerText }),
          ...(data.layout !== undefined && { layout: data.layout }),
        },
      })
    })

    return NextResponse.json({ success: true, template })
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in (error as any) &&
      (error as any).code === 'P2002'
    ) {
      return NextResponse.json(
        { error: 'A template with that name already exists' },
        { status: 409 }
      )
    }
    logger.error({ err: error }, 'Error updating invoice template:')
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
