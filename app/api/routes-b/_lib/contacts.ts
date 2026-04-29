import { prisma } from '@/lib/db'
import { ENABLE_CONTACTS_SOFT_DELETE } from './flags'
import { hasTableColumn } from './table-columns'

type ContactRow = {
  id: string
  userId: string
  name: string
  email: string
  company: string | null
  notes: string | null
  createdAt: Date
  updatedAt: Date
  deletedAt?: Date | null
}

type ContactSummary = Omit<ContactRow, 'userId'>

export async function supportsContactSoftDelete(): Promise<boolean> {
  if (!ENABLE_CONTACTS_SOFT_DELETE) {
    return false
  }

  return hasTableColumn('Contact', 'deletedAt')
}

export async function listContacts(options: {
  userId: string
  search: string | null
  includeDeleted: boolean
}) {
  const softDeleteSupported = await supportsContactSoftDelete()

  if (!softDeleteSupported) {
    return prisma.contact.findMany({
      where: {
        userId: options.userId,
        ...(options.search
          ? {
              OR: [
                { name: { contains: options.search, mode: 'insensitive' } },
                { email: { contains: options.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        email: true,
        company: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
      },
    })
  }

  const params: unknown[] = [options.userId]
  let query = `
    SELECT
      "id",
      "name",
      "email",
      "company",
      "notes",
      "createdAt",
      "updatedAt",
      "deletedAt"
    FROM "Contact"
    WHERE "userId" = $1
  `

  if (!options.includeDeleted) {
    query += ' AND "deletedAt" IS NULL'
  }

  if (options.search) {
    params.push(`%${options.search}%`, `%${options.search}%`)
    query += ` AND ("name" ILIKE $${params.length - 1} OR "email" ILIKE $${params.length})`
  }

  query += ' ORDER BY "name" ASC'

  return (await prisma.$queryRawUnsafe(query, ...params)) as ContactSummary[]
}

export async function findContactById(options: {
  id: string
  userId: string
  includeDeleted: boolean
}) {
  const softDeleteSupported = await supportsContactSoftDelete()

  if (!softDeleteSupported) {
    return prisma.contact.findFirst({
      where: {
        id: options.id,
        userId: options.userId,
      },
    })
  }

  const params: unknown[] = [options.id, options.userId]
  let query = `
    SELECT
      "id",
      "userId",
      "name",
      "email",
      "company",
      "notes",
      "createdAt",
      "updatedAt",
      "deletedAt"
    FROM "Contact"
    WHERE "id" = $1
      AND "userId" = $2
  `

  if (!options.includeDeleted) {
    query += ' AND "deletedAt" IS NULL'
  }

  query += ' LIMIT 1'

  const rows = (await prisma.$queryRawUnsafe(query, ...params)) as ContactRow[]

  return rows[0] ?? null
}

export async function softDeleteContact(options: { id: string; userId: string }) {
  const rows = (await prisma.$queryRawUnsafe(
    `
    UPDATE "Contact"
    SET "deletedAt" = NOW(),
        "updatedAt" = NOW()
    WHERE "id" = $1
      AND "userId" = $2
      AND "deletedAt" IS NULL
    RETURNING
      "id",
      "name",
      "email",
      "company",
      "notes",
      "createdAt",
      "updatedAt",
      "deletedAt"
  `,
    options.id,
    options.userId
  )) as ContactSummary[]

  return rows[0] ?? null
}
