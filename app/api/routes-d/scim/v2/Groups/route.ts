import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group'
const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'

// Matches the only filter SCIM clients commonly send for groups:
//   filter=displayName eq "Engineering"
const DISPLAY_NAME_FILTER = /^displayName\s+eq\s+"([^"]*)"$/i

interface ScimMember {
  value: string
  display?: string
}

function toScimGroup(group: {
  id: string
  displayName: string
  members: unknown
  createdAt: Date
  updatedAt: Date
}) {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: group.id,
    displayName: group.displayName,
    members: (group.members as ScimMember[] | null) ?? [],
    meta: {
      resourceType: 'Group',
      created: group.createdAt,
      lastModified: group.updatedAt,
    },
  }
}

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { searchParams } = new URL(request.url)

    // SCIM pagination is 1-based (RFC 7644 §3.4.2.4)
    const startIndex = Math.max(1, parseInt(searchParams.get('startIndex') ?? '1', 10) || 1)
    const count = Math.min(100, Math.max(0, parseInt(searchParams.get('count') ?? '20', 10) || 20))

    const where: Record<string, unknown> = { userId: user.id }
    const filter = searchParams.get('filter')
    if (filter) {
      const match = DISPLAY_NAME_FILTER.exec(filter.trim())
      if (!match) {
        return NextResponse.json(
          { error: 'Unsupported filter. Only displayName eq "value" is supported' },
          { status: 400 },
        )
      }
      where.displayName = match[1]
    }

    const [groups, totalResults] = await Promise.all([
      (prisma as any).scimGroup.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: startIndex - 1,
        take: count,
      }),
      (prisma as any).scimGroup.count({ where }),
    ])

    return NextResponse.json({
      schemas: [SCIM_LIST_SCHEMA],
      totalResults,
      startIndex,
      itemsPerPage: groups.length,
      Resources: groups.map(toScimGroup),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/scim/v2/Groups error')
    return NextResponse.json({ error: 'Failed to list SCIM groups' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const body = await request.json()
    const { schemas, displayName, members } = body

    if (schemas !== undefined) {
      if (!Array.isArray(schemas) || !schemas.includes(SCIM_GROUP_SCHEMA)) {
        return NextResponse.json(
          { error: `schemas must include ${SCIM_GROUP_SCHEMA}` },
          { status: 400 },
        )
      }
    }
    if (!displayName || typeof displayName !== 'string' || displayName.trim() === '') {
      return NextResponse.json({ error: 'displayName is required' }, { status: 400 })
    }

    let normalizedMembers: ScimMember[] = []
    if (members !== undefined) {
      if (!Array.isArray(members)) {
        return NextResponse.json({ error: 'members must be an array' }, { status: 400 })
      }
      for (const member of members) {
        if (!member || typeof member.value !== 'string' || member.value.trim() === '') {
          return NextResponse.json(
            { error: 'Each member must have a non-empty value' },
            { status: 400 },
          )
        }
      }
      normalizedMembers = members.map((m: ScimMember) => ({
        value: m.value,
        ...(m.display ? { display: m.display } : {}),
      }))
    }

    const existing = await (prisma as any).scimGroup.findFirst({
      where: { userId: user.id, displayName: displayName.trim() },
    })
    if (existing) {
      return NextResponse.json(
        { error: 'A group with this displayName already exists' },
        { status: 409 },
      )
    }

    const group = await (prisma as any).scimGroup.create({
      data: {
        userId: user.id,
        displayName: displayName.trim(),
        members: normalizedMembers,
      },
    })

    return NextResponse.json(toScimGroup(group), { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/scim/v2/Groups error')
    return NextResponse.json({ error: 'Failed to create SCIM group' }, { status: 500 })
  }
}
