import { NextRequest, NextResponse } from 'next/server'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import path from 'path'
import { prisma } from '@/lib/db'
import { getOrCreateUserFromRequest } from '@/app/api/routes-d/finance/_shared'
import { getReceiptAbsolutePath } from '@/lib/file-storage'
import { logger } from '@/lib/logger'

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getOrCreateUserFromRequest(request)
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 })
    }

    const { id } = await params

    const expense = await prisma.expense.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        receiptUrl: true,
      },
    })

    if (!expense) {
      return NextResponse.json({ error: 'Expense not found' }, { status: 404 })
    }

    if (expense.userId !== auth.user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (!expense.receiptUrl) {
      return NextResponse.json({ error: 'Receipt not found' }, { status: 404 })
    }

    const absolutePath = getReceiptAbsolutePath(expense.receiptUrl)
    if (!absolutePath) {
      return NextResponse.json({ error: 'Invalid receipt path' }, { status: 400 })
    }

    if (!existsSync(absolutePath)) {
      return NextResponse.json({ error: 'Receipt file not found' }, { status: 404 })
    }

    const fileBuffer = await readFile(absolutePath)
    const ext = path.extname(absolutePath).toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'

    return new NextResponse(fileBuffer, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="${path.basename(absolutePath)}"`,
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Expense receipt GET error:')
    return NextResponse.json({ error: 'Failed to retrieve expense receipt' }, { status: 500 })
  }
}
