import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { logger } from '@/lib/logger'

export const RAW_GRAPHQL_SDL = `
directive @internal on FIELD_DEFINITION | OBJECT
directive @adminOnly on FIELD_DEFINITION | OBJECT
directive @sqlTable(name: String!) on OBJECT

scalar DateTime
scalar Decimal

enum InvoiceStatus {
  PENDING
  PAID
  OVERDUE
  CANCELLED
}

type User @sqlTable(name: "User") {
  id: ID!
  email: String!
  name: String
  homeCurrency: String!
  twoFactorSecret: String @internal
  internalRiskScore: Int @adminOnly
  createdAt: DateTime!
}

type InvoiceLineItem {
  id: ID!
  description: String!
  quantity: Decimal!
  unitPrice: Decimal!
}

type Invoice @sqlTable(name: "Invoice") {
  id: ID!
  invoiceNumber: String!
  clientEmail: String!
  clientName: String
  description: String!
  amount: Decimal!
  currency: String!
  status: InvoiceStatus!
  dueDate: DateTime
  paidAt: DateTime
  lineItems: [InvoiceLineItem!]!
  encryptedPayload: String @internal
  decryptionSalt: String @internal
  adminOverrideNotes: String @adminOnly
  createdAt: DateTime!
}

type CreditNote {
  id: ID!
  invoiceId: ID!
  creditNumber: String!
  amount: Decimal!
  appliedAmount: Decimal!
  remainingBalance: Decimal!
  currency: String!
  status: String!
  createdAt: DateTime!
}

type InternalAdminAuditRecord @adminOnly {
  id: ID!
  actorAdminId: ID!
  rawPayload: String!
}

type InternalSystemDiagnostics @internal {
  nodeId: String!
  heapUsedBytes: Int!
}

type Query {
  me: User
  invoice(id: ID!): Invoice
  invoices(status: InvoiceStatus, limit: Int = 20, offset: Int = 0): [Invoice!]!
  creditNote(id: ID!): CreditNote
  adminAuditRecords(limit: Int = 50): [InternalAdminAuditRecord!]! @adminOnly
  internalDiagnostics: InternalSystemDiagnostics! @internal
}

type Mutation {
  createInvoice(
    clientEmail: String!
    clientName: String
    description: String!
    amount: Decimal!
    currency: String = "USD"
  ): Invoice!
  cancelInvoice(id: ID!, reason: String): Invoice!
  adminForceRefundOverride(invoiceId: ID!, amount: Decimal!, reason: String!): Invoice! @adminOnly
  internalResetSandboxState(sessionId: ID!): Boolean! @internal
}
`.trim()

/**
 * Strips internal directives (`@internal`, `@adminOnly`, `@sqlTable`),
 * entire object/type definitions marked `@internal` or `@adminOnly`, and
 * individual fields marked `@internal` or `@adminOnly` before rendering the public SDL.
 */
export function buildPublicSchemaSdl(rawSdl: string = RAW_GRAPHQL_SDL): string {
  // 1. Remove entire type/input/interface blocks tagged with @internal or @adminOnly
  const withoutInternalBlocks = rawSdl.replace(
    /^(?:type|input|interface|enum)\s+\w+[^{]*@(?:internal|adminOnly)\b[^{]*\{[\s\S]*?^\}\s*$/gm,
    '',
  )

  const lines = withoutInternalBlocks.split(/\r?\n/)
  const filteredLines: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()

    // 2. Strip internal directive declarations
    if (
      /^directive\s+@(?:internal|adminOnly|sqlTable)\b/.test(trimmed)
    ) {
      continue
    }

    // 3. Strip any field definition tagged with @internal or @adminOnly
    if (/@(?:internal|adminOnly)\b/.test(line)) {
      continue
    }

    // 4. Strip inline @sqlTable(...) directive annotations on public types
    const cleanedLine = line.replace(/\s*@sqlTable\([^)]*\)/g, '')
    filteredLines.push(cleanedLine)
  }

  return (
    filteredLines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  )
}

export function computeSchemaHash(publicSdl: string): string {
  return crypto.createHash('sha256').update(publicSdl, 'utf8').digest('hex')
}

function matchesIfNoneMatch(
  ifNoneMatchHeader: string | null,
  etag: string,
  schemaHash: string,
): boolean {
  if (!ifNoneMatchHeader) return false
  const candidates = ifNoneMatchHeader
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)

  for (const candidate of candidates) {
    if (candidate === '*') return true
    const normalized = candidate.replace(/^W\//, '').replace(/^"|"$/g, '')
    const expectedNormalized = etag.replace(/^"|"$/g, '')
    if (normalized === expectedNormalized || normalized === schemaHash) {
      return true
    }
  }
  return false
}

/**
 * GET /api/graphql/schema
 * Serves the sanitized public GraphQL schema SDL:
 * - Strips internal directives and admin-only types/fields before rendering.
 * - Includes `ETag` and `X-Schema-Hash` headers for client codegen caching.
 * - Supports conditional `If-None-Match` (`304 Not Modified`) and content negotiation
 *   (`application/graphql`, `text/plain`, and `application/json`).
 */
export async function GET(req: NextRequest) {
  try {
    const publicSdl = buildPublicSchemaSdl(RAW_GRAPHQL_SDL)
    const schemaHash = computeSchemaHash(publicSdl)
    const etag = `"sha256-${schemaHash}"`
    const cacheControl =
      'public, max-age=300, s-maxage=600, stale-while-revalidate=60'

    const baseHeaders: Record<string, string> = {
      ETag: etag,
      'X-Schema-Hash': schemaHash,
      'Cache-Control': cacheControl,
      Vary: 'Accept',
    }

    const ifNoneMatch = req.headers.get('if-none-match')
    if (matchesIfNoneMatch(ifNoneMatch, etag, schemaHash)) {
      return new NextResponse(null, {
        status: 304,
        headers: baseHeaders,
      })
    }

    const { searchParams } = new URL(req.url)
    const formatParam = searchParams.get('format')?.trim().toLowerCase()
    const acceptHeader = (req.headers.get('accept') ?? '').toLowerCase()

    if (
      formatParam === 'json' ||
      (acceptHeader.includes('application/json') &&
        !acceptHeader.includes('application/graphql') &&
        !acceptHeader.includes('text/plain'))
    ) {
      return NextResponse.json(
        {
          sdl: publicSdl,
          schemaHash,
          etag,
        },
        {
          status: 200,
          headers: baseHeaders,
        },
      )
    }

    const contentType =
      formatParam === 'graphql' || acceptHeader.includes('application/graphql')
        ? 'application/graphql; charset=utf-8'
        : 'text/plain; charset=utf-8'

    return new NextResponse(publicSdl, {
      status: 200,
      headers: {
        ...baseHeaders,
        'Content-Type': contentType,
      },
    })
  } catch (err) {
    logger?.error?.({ err }, 'GET /api/graphql/schema error')
    return NextResponse.json(
      { error: 'Failed to serve GraphQL schema SDL' },
      { status: 500 },
    )
  }
}
