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

type ListContactsOptions = {
  userId: string
  search: string | null
  includeDeleted: boolean
  sort?: 'name' | 'createdAt' | 'lastUsed'
  order?: 'asc' | 'desc'
  tag?: string | null
}

export async function listContacts(options: ListContactsOptions) {
  const sort = options.sort ?? 'createdAt'
  const order = options.order ?? 'desc'
  const softDeleteSupported = await supportsContactSoftDelete()

  if (!softDeleteSupported) {
    const where: Record<string, unknown> = { userId: options.userId }

    const searchTerm = options.search
    if (searchTerm) {
      where.OR = [
        { name: { contains: searchTerm, mode: 'insensitive' } },
        { email: { contains: searchTerm, mode: 'insensitive' } },
      ]
    }

    if (options.tag) {
      // Filter contacts whose email appears on invoices tagged with the given tag name
      const taggedEmails = await prisma.invoice.findMany({
        where: {
          userId: options.userId,
          invoiceTags: { some: { tag: { name: options.tag } } },
        },
        select: { clientEmail: true },
        distinct: ['clientEmail'],
      })
      where.email = { in: taggedEmails.map((i: { clientEmail: string }) => i.clientEmail) }
    }

    // lastUsed: derive from most recent invoice for that contact email
    if (sort === 'lastUsed') {
      const contacts = await prisma.contact.findMany({
        where,
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
      // Fetch last invoice dates per email in one query
      const emails = contacts.map((c: { email: string }) => c.email)
      const lastInvoices = await prisma.invoice.groupBy({
        by: ['clientEmail'],
        where: { userId: options.userId, clientEmail: { in: emails } },
        _max: { createdAt: true },
      })
      const lastUsedMap = new Map(
        lastInvoices.map((r: { clientEmail: string; _max: { createdAt: Date | null } }) => [r.clientEmail, r._max.createdAt]),
      )
      return contacts.sort((a: { email: string; name: string; createdAt: Date }, b: { email: string; name: string; createdAt: Date }) => {
        const aDate = lastUsedMap.get(a.email)?.getTime() ?? 0
        const bDate = lastUsedMap.get(b.email)?.getTime() ?? 0
        return order === 'asc' ? aDate - bDate : bDate - aDate
      })
    }

    const prismaSort = sort === 'name' ? { name: order } : { createdAt: order }

    return prisma.contact.findMany({
      where,
      orderBy: prismaSort,
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

  // --- soft-delete enabled path (raw SQL) ---
  const params: unknown[] = [options.userId]
  let query = `
    SELECT
      c."id",
      c."name",
      c."email",
      c."company",
      c."notes",
      c."createdAt",
      c."updatedAt",
      c."deletedAt"
    FROM "Contact" c
    WHERE c."userId" = $1
  `

  if (!options.includeDeleted) {
    query += ' AND c."deletedAt" IS NULL'
  }

  if (options.search) {
    params.push(`%${options.search}%`, `%${options.search}%`)
    query += ` AND (c."name" ILIKE $${params.length - 1} OR c."email" ILIKE $${params.length})`
  }

  if (options.tag) {
    params.push(options.tag)
    query += `
      AND c."email" IN (
        SELECT DISTINCT i."clientEmail"
        FROM "Invoice" i
        JOIN "InvoiceTag" it ON it."invoiceId" = i."id"
        JOIN "Tag" t ON t."id" = it."tagId"
        WHERE i."userId" = $1 AND t."name" = $${params.length}
      )
    `
  }

  if (sort === 'lastUsed') {
    const orderDir = order === 'asc' ? 'ASC' : 'DESC'
    query += `
      ORDER BY (
        SELECT MAX(i."createdAt") FROM "Invoice" i
        WHERE i."userId" = $1 AND i."clientEmail" = c."email"
      ) ${orderDir} NULLS LAST
    `
  } else if (sort === 'name') {
    query += ` ORDER BY c."name" ${order === 'asc' ? 'ASC' : 'DESC'}`
  } else {
    // createdAt (default)
    query += ` ORDER BY c."createdAt" ${order === 'asc' ? 'ASC' : 'DESC'}`
  }

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
