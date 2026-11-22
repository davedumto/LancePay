import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import {
  parse,
  print,
  visit,
  type DirectiveNode,
} from 'graphql'
import { logger } from '@/lib/logger'

export function getSchemaFilePath(): string {
  if (process.env.GRAPHQL_SCHEMA_PATH) {
    return process.env.GRAPHQL_SCHEMA_PATH
  }
  return path.join(process.cwd(), 'lib/graphql/schema.graphql')
}

function hasRestrictedDirective(node: { directives?: readonly DirectiveNode[] }): boolean {
  return Boolean(
    node.directives?.some(
      (d) => d.name.value === 'internal' || d.name.value === 'private',
    ),
  )
}

export function filterPublicSchema(rawSdl: string): string {
  const ast = parse(rawSdl)
  const filtered = visit(ast, {
    DirectiveDefinition(node) {
      if (node.name.value === 'internal' || node.name.value === 'private') {
        return null
      }
    },
    ObjectTypeDefinition(node) {
      if (hasRestrictedDirective(node)) return null
    },
    InputObjectTypeDefinition(node) {
      if (hasRestrictedDirective(node)) return null
    },
    InterfaceTypeDefinition(node) {
      if (hasRestrictedDirective(node)) return null
    },
    UnionTypeDefinition(node) {
      if (hasRestrictedDirective(node)) return null
    },
    EnumTypeDefinition(node) {
      if (hasRestrictedDirective(node)) return null
    },
    ScalarTypeDefinition(node) {
      if (hasRestrictedDirective(node)) return null
    },
    ObjectTypeExtension(node) {
      if (hasRestrictedDirective(node)) return null
    },
    InputObjectTypeExtension(node) {
      if (hasRestrictedDirective(node)) return null
    },
    InterfaceTypeExtension(node) {
      if (hasRestrictedDirective(node)) return null
    },
    UnionTypeExtension(node) {
      if (hasRestrictedDirective(node)) return null
    },
    EnumTypeExtension(node) {
      if (hasRestrictedDirective(node)) return null
    },
    ScalarTypeExtension(node) {
      if (hasRestrictedDirective(node)) return null
    },
    FieldDefinition(node) {
      if (hasRestrictedDirective(node)) return null
    },
    InputValueDefinition(node) {
      if (hasRestrictedDirective(node)) return null
    },
    EnumValueDefinition(node) {
      if (hasRestrictedDirective(node)) return null
    },
  })

  return print(filtered).trim() + '\n'
}

export function computeSchemaHash(sdl: string): string {
  return crypto.createHash('sha256').update(sdl, 'utf8').digest('hex')
}

/**
 * GET /api/graphql/schema
 *
 * Serves the public GraphQL SDL filtered to public gateway-exposed fields.
 * - Filters out fields and types marked with @internal or @private.
 * - Sets long cache headers tied to the build-time schema hash.
 * - Supports conditional GET (304 Not Modified on ETag match).
 * - Fails closed (503 Service Unavailable) if schema file is missing.
 */
export async function GET(request: NextRequest) {
  try {
    const schemaPath = getSchemaFilePath()

    // Fail closed: if schema file does not exist, fail immediately
    if (!fs.existsSync(schemaPath)) {
      logger.error({ schemaPath }, 'GraphQL schema file missing: failing closed')
      return NextResponse.json(
        {
          error: 'GraphQL schema file missing: gateway schema unavailable',
          code: 'SCHEMA_FILE_MISSING',
        },
        { status: 503 },
      )
    }

    let rawSchema: string
    try {
      rawSchema = fs.readFileSync(schemaPath, 'utf8')
    } catch (readErr) {
      logger.error({ err: readErr, schemaPath }, 'Failed to read GraphQL schema file')
      return NextResponse.json(
        {
          error: 'Failed to read GraphQL schema file',
          code: 'SCHEMA_READ_ERROR',
        },
        { status: 500 },
      )
    }

    let publicSdl: string
    try {
      publicSdl = filterPublicSchema(rawSchema)
    } catch (parseErr) {
      logger.error({ err: parseErr, schemaPath }, 'Failed to parse GraphQL schema SDL: failing closed')
      return NextResponse.json(
        {
          error: 'Failed to parse GraphQL schema SDL: gateway schema unavailable',
          code: 'SCHEMA_PARSE_ERROR',
        },
        { status: 500 },
      )
    }
    const schemaHash = computeSchemaHash(publicSdl)
    const etag = `"${schemaHash}"`

    // Check If-None-Match for 304 conditional request
    const clientEtag = request.headers.get('if-none-match')?.trim()
    if (clientEtag && (clientEtag === etag || clientEtag === schemaHash)) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      })
    }

    const { searchParams } = new URL(request.url)
    const wantsJson =
      searchParams.get('format') === 'json' ||
      request.headers.get('accept')?.includes('application/json')

    if (wantsJson) {
      return NextResponse.json(
        {
          schema: publicSdl,
          hash: schemaHash,
        },
        {
          status: 200,
          headers: {
            ETag: etag,
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        },
      )
    }

    return new NextResponse(publicSdl, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        ETag: etag,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/graphql/schema error')
    return NextResponse.json({ error: 'Failed to retrieve GraphQL schema' }, { status: 500 })
  }
}
