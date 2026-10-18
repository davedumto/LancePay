import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export type EvaluatorFieldType = 'string' | 'number' | 'boolean'

export type CohortOperator =
  | 'eq'
  | 'neq'
  | 'in'
  | 'not_in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'

export const EVALUATOR_READABLE_FIELDS: Record<
  string,
  { type: EvaluatorFieldType; operators: readonly CohortOperator[] }
> = {
  userId: { type: 'string', operators: ['eq', 'neq', 'in', 'not_in'] },
  role: { type: 'string', operators: ['eq', 'neq', 'in', 'not_in'] },
  countryCode: { type: 'string', operators: ['eq', 'neq', 'in', 'not_in'] },
  homeCurrency: { type: 'string', operators: ['eq', 'neq', 'in', 'not_in'] },
  kycLevel: { type: 'string', operators: ['eq', 'neq', 'in', 'not_in'] },
  kycVerified: { type: 'boolean', operators: ['eq', 'neq'] },
  trustScore: {
    type: 'number',
    operators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  },
  totalVolumeUsdc: {
    type: 'number',
    operators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  },
  accountAgeDays: {
    type: 'number',
    operators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  },
}

export interface CohortRule {
  field: string
  operator: CohortOperator
  value: string | number | boolean | string[]
}

const FLAG_KEY_REGEX = /^[a-z][a-z0-9_.-]{2,63}$/

export function validateCohortRules(
  rawRules: unknown,
):
  | { valid: true; rules: CohortRule[] }
  | { valid: false; code: string; error: string; field?: string } {
  if (!Array.isArray(rawRules)) {
    return {
      valid: false,
      code: 'INVALID_COHORT_RULE_SCHEMA',
      error: 'cohortRules must be an array of cohort rule objects',
    }
  }

  const validated: CohortRule[] = []

  for (let i = 0; i < rawRules.length; i++) {
    const item = rawRules[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return {
        valid: false,
        code: 'INVALID_COHORT_RULE_SCHEMA',
        error: `cohortRules[${i}] must be a non-null object`,
      }
    }

    const ruleObj = item as Record<string, unknown>
    const allowedKeys = new Set(['field', 'operator', 'value', 'description'])
    for (const k of Object.keys(ruleObj)) {
      if (!allowedKeys.has(k)) {
        return {
          valid: false,
          code: 'INVALID_COHORT_RULE_SCHEMA',
          error: `cohortRules[${i}] contains unsupported property "${k}"`,
        }
      }
    }

    const field =
      typeof ruleObj.field === 'string' ? ruleObj.field.trim() : ''
    const operator =
      typeof ruleObj.operator === 'string'
        ? (ruleObj.operator.trim() as CohortOperator)
        : ('' as CohortOperator)
    const value = ruleObj.value

    if (!field || !operator || value === undefined) {
      return {
        valid: false,
        code: 'INVALID_COHORT_RULE_SCHEMA',
        error: `cohortRules[${i}] must specify field, operator, and value`,
      }
    }

    const fieldSpec = EVALUATOR_READABLE_FIELDS[field]
    if (!fieldSpec) {
      return {
        valid: false,
        code: 'UNREADABLE_EVALUATOR_FIELD',
        field,
        error: `Cohort rule references field "${field}" which the runtime evaluator cannot read. Allowed fields: ${Object.keys(
          EVALUATOR_READABLE_FIELDS,
        ).join(', ')}`,
      }
    }

    if (!fieldSpec.operators.includes(operator)) {
      return {
        valid: false,
        code: 'INVALID_COHORT_RULE_SCHEMA',
        field,
        error: `Operator "${operator}" is not supported for field "${field}" (${fieldSpec.type})`,
      }
    }

    if (operator === 'in' || operator === 'not_in') {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        !value.every((v) => typeof v === 'string' && v.trim().length > 0)
      ) {
        return {
          valid: false,
          code: 'INVALID_COHORT_RULE_SCHEMA',
          field,
          error: `cohortRules[${i}].value for "${operator}" must be a non-empty array of strings`,
        }
      }
      validated.push({ field, operator, value })
    } else if (fieldSpec.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return {
          valid: false,
          code: 'INVALID_COHORT_RULE_SCHEMA',
          field,
          error: `cohortRules[${i}].value for numeric field "${field}" must be a finite number`,
        }
      }
      validated.push({ field, operator, value })
    } else if (fieldSpec.type === 'boolean') {
      if (typeof value !== 'boolean') {
        return {
          valid: false,
          code: 'INVALID_COHORT_RULE_SCHEMA',
          field,
          error: `cohortRules[${i}].value for boolean field "${field}" must be a boolean`,
        }
      }
      validated.push({ field, operator, value })
    } else {
      if (typeof value !== 'string' || !value.trim()) {
        return {
          valid: false,
          code: 'INVALID_COHORT_RULE_SCHEMA',
          field,
          error: `cohortRules[${i}].value for string field "${field}" must be a non-empty string`,
        }
      }
      validated.push({ field, operator, value: value.trim() })
    }
  }

  return { valid: true, rules: validated }
}

async function requireAdminActor(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, admin: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, admin: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, admin: null }
  }

  let adminId = claims.userId
  let adminEmail = (claims as { email?: string | null }).email ?? null
  let role = (claims as { role?: string | null }).role ?? null

  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser =
      (await prisma.user.findUnique({
        where: { privyId: claims.userId },
        select: { id: true, email: true, role: true },
      })) ??
      (await prisma.user.findUnique({
        where: { id: claims.userId },
        select: { id: true, email: true, role: true },
      }))

    if (dbUser) {
      adminId = dbUser.id
      adminEmail = dbUser.email ?? adminEmail
      role = dbUser.role ?? role
    }
  }

  const normalizedRole = (role ?? '').toLowerCase()
  if (
    normalizedRole !== 'admin' &&
    normalizedRole !== 'super_admin' &&
    normalizedRole !== 'release_manager' &&
    normalizedRole !== 'ops_admin'
  ) {
    return {
      error: 'Forbidden: Admin access required',
      status: 403 as const,
      admin: null,
    }
  }

  return {
    error: null,
    status: 200 as const,
    admin: { id: adminId, email: adminEmail, role: normalizedRole },
  }
}

/**
 * POST /api/admin/feature-flags
 * Creates a new feature flag with cohort rules:
 * - Validates cohort rule shape against the schema and rejects rules referencing fields the evaluator cannot read.
 * - Rejects reusing a flag key that already exists even if the previous flag has been archived.
 * - Records the creating admin on the flag so later audits can trace the owner.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdminActor(req)
    if (auth.error || !auth.admin) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const key = typeof body.key === 'string' ? body.key.trim() : ''
    if (!key || !FLAG_KEY_REGEX.test(key)) {
      return NextResponse.json(
        {
          error:
            'key is required and must match /^[a-z][a-z0-9_.-]{2,63}$/',
          code: 'INVALID_FLAG_KEY',
        },
        { status: 400 },
      )
    }

    const description =
      typeof body.description === 'string' && body.description.trim()
        ? body.description.trim()
        : null
    const enabled =
      typeof body.enabled === 'boolean' ? body.enabled : false
    const rolloutPercentage =
      body.rolloutPercentage !== undefined ? Number(body.rolloutPercentage) : 0

    if (
      !Number.isFinite(rolloutPercentage) ||
      rolloutPercentage < 0 ||
      rolloutPercentage > 100
    ) {
      return NextResponse.json(
        {
          error: 'rolloutPercentage must be a number between 0 and 100',
          code: 'INVALID_ROLLOUT_PERCENTAGE',
        },
        { status: 400 },
      )
    }

    const rawCohortRules =
      body.cohortRules !== undefined ? body.cohortRules : []
    const cohortValidation = validateCohortRules(rawCohortRules)
    if (!cohortValidation.valid) {
      return NextResponse.json(
        {
          error: cohortValidation.error,
          code: cohortValidation.code,
          field: cohortValidation.field ?? null,
          allowedFields: Object.keys(EVALUATOR_READABLE_FIELDS),
        },
        { status: 400 },
      )
    }

    const db = prisma as unknown as {
      featureFlag?: {
        findUnique: (args: unknown) => Promise<Record<string, any> | null>
        create: (args: unknown) => Promise<Record<string, any>>
      }
      auditLog?: {
        create: (args: unknown) => Promise<Record<string, any>>
      }
    }

    // Check if flag key already exists (including archived flags)
    const existingFlag = await db.featureFlag?.findUnique({
      where: { key },
    })

    if (existingFlag) {
      const wasArchived = Boolean(
        existingFlag.archived === true ||
          existingFlag.status === 'archived' ||
          existingFlag.archivedAt != null,
      )
      return NextResponse.json(
        {
          error: wasArchived
            ? `Feature flag key "${key}" cannot be reused because a previous flag with this key was archived`
            : `Feature flag key "${key}" already exists`,
          code: 'FLAG_KEY_ALREADY_EXISTS',
          key,
          wasArchived,
        },
        { status: 409 },
      )
    }

    const concurrencyToken = `v1_${crypto.randomBytes(6).toString('hex')}`
    const now = new Date()

    const initialChangeEntry = {
      version: 1,
      changedAt: now.toISOString(),
      changedByAdminId: auth.admin.id,
      changedByEmail: auth.admin.email,
      reason: 'Initial feature flag creation',
      previousConfig: null,
      newConfig: {
        enabled,
        rolloutPercentage,
        cohortRules: cohortValidation.rules,
        version: 1,
        concurrencyToken,
      },
    }

    const createdFlag = await db.featureFlag!.create({
      data: {
        key,
        description,
        enabled,
        status: 'active',
        archived: false,
        rolloutPercentage,
        cohortRules: cohortValidation.rules,
        createdByAdminId: auth.admin.id,
        createdByEmail: auth.admin.email,
        version: 1,
        concurrencyToken,
        changeHistory: [initialChangeEntry],
      },
    })

    await db.auditLog?.create({
      data: {
        actorId: auth.admin.id,
        actorEmail: auth.admin.email,
        action: 'admin.feature_flag.create',
        resourceType: 'FeatureFlag',
        resourceId: key,
        metadata: {
          key,
          enabled,
          rolloutPercentage,
          cohortRules: cohortValidation.rules,
          createdByAdminId: auth.admin.id,
          createdByEmail: auth.admin.email,
        },
      },
    })

    logger?.info?.(
      {
        key,
        createdByAdminId: auth.admin.id,
        ruleCount: cohortValidation.rules.length,
      },
      'POST /api/admin/feature-flags created feature flag',
    )

    return NextResponse.json(
      {
        featureFlag: {
          ...createdFlag,
          key,
          description,
          enabled,
          status: 'active',
          archived: false,
          rolloutPercentage,
          cohortRules: cohortValidation.rules,
          createdByAdminId: auth.admin.id,
          createdByEmail: auth.admin.email,
          version: 1,
          concurrencyToken,
        },
      },
      { status: 201 },
    )
  } catch (err) {
    logger?.error?.({ err }, 'POST /api/admin/feature-flags error')
    return NextResponse.json(
      { error: 'Failed to create feature flag' },
      { status: 500 },
    )
  }
}
