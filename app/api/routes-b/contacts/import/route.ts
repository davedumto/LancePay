import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { parseCsvStream } from '../../_lib/csv-import'
import { validateContact, parseTags, normalizeEmail, ImportResult } from '../../_lib/contact-validation'
import { registerRoute } from '../../_lib/openapi'
import { z } from 'zod'
import { isEnabled } from '../../_lib/flags'

// Register OpenAPI documentation
registerRoute({
  method: 'POST',
  path: '/contacts/import',
  summary: 'Import contacts from CSV',
  description: 'Bulk import contacts from CSV file. Required column: name. Optional columns: email, phone, company, tags.',
  responseSchema: z.object({
    results: z.array(z.object({
      row: z.number(),
      ok: z.boolean(),
      contactId: z.string().optional(),
      error: z.string().optional()
    })),
    summary: z.object({
      total: z.number(),
      imported: z.number(),
      skipped: z.number(),
      failed: z.number()
    })
  }),
  tags: ['contacts']
})

async function POSTHandler(request: NextRequest) {
  // Check authentication
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // Check feature flag
  if (!isEnabled('bulk-contacts-import', { userId: user.id })) {
    return NextResponse.json(
      { error: 'Bulk contacts import is not available' },
      { status: 403 }
    )
  }

  // Check content type
  const contentType = request.headers.get('content-type')
  if (!contentType?.includes('text/csv')) {
    return NextResponse.json(
      { error: 'Content-Type must be text/csv' },
      { status: 415 }
    )
  }

  try {
    const results: ImportResult[] = []
    const seenEmails = new Set<string>()
    const seenInFile = new Set<string>()
    
    let rowNumber = 0
    let importedCount = 0
    let failedCount = 0
    let skippedCount = 0

    // Parse CSV stream
    for await (const csvRow of parseCsvStream(request.body!, {
      maxSizeBytes: 2 * 1024 * 1024, // 2 MiB
      maxRows: 10000,
      requiredColumns: ['name']
    })) {
      rowNumber++

      // Validate row
      const validation = validateContact(csvRow, rowNumber)
      
      if (!validation.ok) {
        results.push({
          row: rowNumber,
          ok: false,
          error: validation.errors?.join(', ') || 'Validation failed'
        })
        failedCount++
        continue
      }

      const { name, email, phone, company, tags } = validation.data
      const normalizedEmail = normalizeEmail(email)

      // Dedupe within file
      if (normalizedEmail) {
        if (seenInFile.has(normalizedEmail)) {
          results.push({
            row: rowNumber,
            ok: false,
            error: 'Duplicate email within file'
          })
          skippedCount++
          continue
        }
        seenInFile.add(normalizedEmail)
      }

      try {
        // Check for existing contact by email
        let existingContact = null
        if (normalizedEmail) {
          existingContact = await prisma.contact.findFirst({
            where: {
              userId: user.id,
              email: normalizedEmail
            },
            select: { id: true }
          })
        }

        if (existingContact) {
          results.push({
            row: rowNumber,
            ok: false,
            error: 'Contact with this email already exists'
          })
          skippedCount++
          continue
        }

        // Create contact
        const contact = await prisma.contact.create({
          data: {
            userId: user.id,
            name,
            email: normalizedEmail,
            phone: phone || null,
            company: company || null,
            notes: null
          }
        })

        // Create tags if provided
        const tagNames = parseTags(tags)
        if (tagNames.length > 0) {
          // Get or create tags
          const tagPromises = tagNames.map(async (tagName) => {
            const tag = await prisma.tag.upsert({
              where: {
                userId_name: {
                  userId: user.id,
                  name: tagName
                }
              },
              update: {},
              create: {
                userId: user.id,
                name: tagName,
                color: '#6366f1' // Default color
              }
            })
            return tag.id
          })

          const tagIds = await Promise.all(tagPromises)
          
          // Link tags to contact
          await prisma.contactTag.createMany({
            data: tagIds.map(tagId => ({
              contactId: contact.id,
              tagId
            })),
            skipDuplicates: true
          })
        }

        results.push({
          row: rowNumber,
          ok: true,
          contactId: contact.id
        })
        importedCount++

        if (normalizedEmail) {
          seenEmails.add(normalizedEmail)
        }
      } catch (error) {
        results.push({
          row: rowNumber,
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to create contact'
        })
        failedCount++
      }
    }

    return NextResponse.json({
      results,
      summary: {
        total: rowNumber,
        imported: importedCount,
        skipped: skippedCount,
        failed: failedCount
      }
    })

  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('exceeds limit') || error.message.includes('exceeds maximum')) {
        return NextResponse.json(
          { error: error.message },
          { status: 413 }
        )
      }
      if (error.message.includes('Missing required columns')) {
        return NextResponse.json(
          { error: error.message },
          { status: 400 }
        )
      }
    }

    return NextResponse.json(
      { error: 'Failed to process CSV import' },
      { status: 500 }
    )
  }
}

export const POST = withRequestId(POSTHandler)
