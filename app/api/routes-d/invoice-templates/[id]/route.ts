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

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const claims = await verifyAuthToken(request.headers.get('authorization')?.replace('Bearer ', '') || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const template = await prisma.invoiceTemplate.findFirst({ where: { id: params.id, userId: user.id } })
  if (!template) return NextResponse.json({ error: 'Template not found' }, { status: 404 })

  return NextResponse.json({ success: true, template })
}

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const claims = await verifyAuthToken(request.headers.get('authorization')?.replace('Bearer ', '') || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const body = await request.json()
  const result = templateSchema.safeParse(body)
  if (!result.success) return NextResponse.json({ error: 'Validation failed', details: result.error.flatten().fieldErrors }, { status: 400 })

  if (result.data.isDefault) {
    await prisma.invoiceTemplate.updateMany({ where: { userId: user.id }, data: { isDefault: false } })
  }

  const template = await prisma.invoiceTemplate.update({
    where: { id: params.id },
    data: result.data
  })

  return NextResponse.json({ success: true, template })
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const claims = await verifyAuthToken(request.headers.get('authorization')?.replace('Bearer ', '') || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  await prisma.invoiceTemplate.delete({ where: { id: params.id } })
  return NextResponse.json({ success: true, message: 'Template deleted' })
}
