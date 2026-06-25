import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    if (!id) {
      return NextResponse.json({ error: 'Invoice ID is required' }, { status: 400 })
    }

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

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      select: { id: true, userId: true, description: true, amount: true, status: true },
    })

    if (!invoice || invoice.userId !== user.id) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (invoice.status !== 'pending') {
      return NextResponse.json({ error: 'Only pending invoices can have AI drafts generated' }, { status: 422 })
    }

    const body = await request.json().catch(() => ({}))
    const { prompt } = body

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 })
    }

    // Call AI to generate description based on the prompt/keywords
    const { text } = await generateText({
      model: openai('gpt-4o'),
      system: `You are a professional business assistant. 
Your task is to convert simple keywords or instructions into a professional, clear, and itemized invoice description. 
The tone should be formal and suitable for a freelance or business invoice. 
Format the output as a concise paragraph or a clear list if multiple items are detected.
Avoid fluff and focus on clarity.`,
      prompt: `Translate these keywords into a professional invoice description: ${prompt}`,
    })

    const updatedInvoice = await prisma.invoice.update({
      where: { id: invoice.id },
      data: { description: text },
      select: {
        id: true,
        invoiceNumber: true,
        description: true,
        amount: true,
        status: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ invoice: { ...updatedInvoice, amount: Number(updatedInvoice.amount) } })
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Failed to generate AI draft' }, { status: 500 })
  }
}
