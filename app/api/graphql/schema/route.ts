import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { logger } from '@/lib/logger'

export function getSchemaFilePath(): string {
  if (process.env.GRAPHQL_SCHEMA_PATH) {
    return process.env.GRAPHQL_SCHEMA_PATH
  }
  return path.join(process.cwd(), 'lib/graphql/schema.graphql')
}

export function filterPublicSchema(rawSdl: string): string {
  const lines = rawSdl.split('\n')
  const filteredLines: string[] = []
  let insideInternalType = false
  let currentBraceDepth = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // Skip directive declarations for internal directives
    if (/^directive\s+@(internal|private)\b/.test(trimmed)) {
      continue
    }

    // Check if this line starts a type marked with @internal or @private
    if (/^(type|input|interface|union|enum)\s+\w+.*@(internal|private)\b/.test(trimmed)) {
      insideInternalType = true
      currentBraceDepth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length
      // If single line type, reset immediately
      if (currentBraceDepth <= 0 && line.includes('{') && line.includes('}')) {
        insideInternalType = false
      }
      continue
    }

    if (insideInternalType) {
      currentBraceDepth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length
      if (currentBraceDepth <= 0) {
        insideInternalType = false
      }
      continue
    }

    // Skip individual fields marked with @internal or @private
    if (/@(internal|private)\b/.test(line)) {
      continue
    }

    filteredLines.push(line)
  }

  // Trim trailing empty lines
  return filteredLines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
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

    const publicSdl = filterPublicSchema(rawSchema)
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
