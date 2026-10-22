import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { verifyAuthToken } from '@/lib/auth'

export const EVALUATOR_SUPPORTED_FIELDS = new Set([
  'id',
  'userId',
  'email',
  'role',
  'tier',
  'country',
  'isKycVerified',
  'environment',
  'device',
  'platform',
  'version',
  'ip',
])

export const cohortRuleSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  field: z.string().trim().min(1, 'Rule field is required'),
  operator: z.enum([
    'equals',
    'not_equals',
    'in',
    'not_in',
    'contains',
    'greater_than',
    'less_than',
    'matches',
    'percentage',
  ]),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number()])),
  ]),
})

const createFeatureFlagSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, 'Flag key is required')
    .max(100, 'Flag key must not exceed 100 characters')
    .regex(/^[a-z0-9_-]+$/, 'Flag key must only contain lowercase alphanumeric characters, underscores, or hyphens'),
  name: z.string().trim().min(1, 'Flag name is required').max(255),
  description: z.string().trim().optional(),
  cohortRules: z.array(cohortRuleSchema).default([]),
  enabled: z.boolean().default(false),
})

async function getAuthenticatedAdmin(request: NextRequest): Promise<{ id: string; email: string } | null> {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null

  const claims = await verifyAuthToken(authToken)
  if (!claims?.userId) return null

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, email: true, role: true },
  })

  if (!user || user.role !== 'admin') {
    return null
  }

  return { id: user.id, email: user.email }
}

/**
 * POST /api/admin/feature-flags
 *
 * Allows a platform admin to create a feature flag with structured cohort rules.
 * - Validates cohort rule schema and rejects fields the evaluator cannot read.
 * - Rejects reusing an existing key even if the previous flag has been archived.
 * - Records the creating admin on the flag for audit tracing.
 */
export async function POST(request: NextRequest) {
  try {
    const admin = await getAuthenticatedAdmin(request)
    if (!admin) {
      return NextResponse.json(
        { error: 'Forbidden: admin access required', code: 'FORBIDDEN' },
        { status: 403 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = createFeatureFlagSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }

    const { key, name, description, cohortRules, enabled } = parsed.data
    const normalizedKey = key.toLowerCase()

    // Validate cohort rule fields against evaluator supported fields
    for (const rule of cohortRules) {
      if (!EVALUATOR_SUPPORTED_FIELDS.has(rule.field)) {
        return NextResponse.json(
          {
            error: `Cohort rule references unsupported evaluator field: '${rule.field}'`,
            code: 'UNSUPPORTED_EVALUATOR_FIELD',
            unsupportedField: rule.field,
            supportedFields: Array.from(EVALUATOR_SUPPORTED_FIELDS),
          },
          { status: 400 },
        )
      }
    }

    // Check key uniqueness across active and archived flags
    const existing = await prisma.featureFlag.findFirst({
      where: { key: normalizedKey },
      select: { id: true, key: true, archived: true },
    })

    if (existing) {
      return NextResponse.json(
        {
          error: `Flag key '${normalizedKey}' already exists${existing.archived ? ' (archived)' : ''}`,
          code: 'FLAG_KEY_EXISTS',
          archived: existing.archived,
        },
        { status: 409 },
      )
    }

    const featureFlag = await prisma.featureFlag.create({
      data: {
        key: normalizedKey,
        name,
        description: description || null,
        cohortRules: cohortRules as any,
        enabled,
        archived: false,
        createdById: admin.id,
      },
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        cohortRules: true,
        enabled: true,
        archived: true,
        createdById: true,
        createdAt: true,
        updatedAt: true,
        createdBy: {
          select: {
            id: true,
            email: true,
          },
        },
      },
    })

    logger.info(
      { adminId: admin.id, flagKey: normalizedKey, rulesCount: cohortRules.length },
      'Admin created feature flag',
    )

    return NextResponse.json({ featureFlag }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/admin/feature-flags error')
    return NextResponse.json({ error: 'Failed to create feature flag' }, { status: 500 })
  }
}
