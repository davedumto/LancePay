import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { z } from 'zod'

const templateSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  isDefault: z.boolean().optional(),
  logoUrl: z.string().url().optional().nullable(),
  primaryColor: z.string().regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/).optional(),
  accentColor: z.string().regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/).optional(),
  showLogo: z.boolean().optional(),
  showFooter: z.boolean().optional(),
  footerText: z.string().max(500).optional().nullable(),
  layout: z.enum(['modern', 'classic', 'minimal']).optional(),
})

export async function GET(request: NextRequest) {
  const claims = await verifyAuthToken(request.headers.get('authorization')?.replace('Bearer ', '') || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const templates = await prisma.invoiceTemplate.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' }
  })

  return NextResponse.json({ success: true, templates })
}

export async function POST(request: NextRequest) {
  const claims = await verifyAuthToken(request.headers.get('authorization')?.replace('Bearer ', '') || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const count = await prisma.invoiceTemplate.count({ where: { userId: user.id } })
  if (count >= 5) return NextResponse.json({ error: 'Maximum 5 templates allowed' }, { status: 400 })

  const body = await request.json()
  const result = templateSchema.safeParse(body)
  if (!result.success) return NextResponse.json({ error: 'Validation failed', details: result.error.flatten().fieldErrors }, { status: 400 })

  if (result.data.isDefault) {
    await prisma.invoiceTemplate.updateMany({ where: { userId: user.id }, data: { isDefault: false } })
  }

  const template = await prisma.invoiceTemplate.create({
    data: { userId: user.id, ...result.data }
  })

  return NextResponse.json({ success: true, template }, { status: 201 })
}
