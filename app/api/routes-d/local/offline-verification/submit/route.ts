import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { validateReceiptFile, storeReceiptFile } from '@/lib/file-storage'
import { z } from 'zod'

const SubmitPaymentSchema = z.object({
  invoiceNumber: z.string().min(1),
  clientName: z.string().min(1).max(100),
  amountPaid: z.string().regex(/^\d+(\.\d{1,2})?$/),
  currency: z.string().default('NGN'),
  notes: z.string().max(1000).optional(),
})

export async function POST(request: NextRequest) {
  try {
    // Parse FormData
    const form = await request.formData()
    const file = form.get('receipt')

    // Validate file
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'Receipt file is required' },
        { status: 400 }
      )
    }

    const fileValidation = validateReceiptFile(file)
    if (!fileValidation.valid) {
      return NextResponse.json({ error: fileValidation.error }, { status: 400 })
    }

    // Parse and validate body
    const bodyData = {
      invoiceNumber: form.get('invoiceNumber'),
      clientName: form.get('clientName'),
      amountPaid: form.get('amountPaid'),
      currency: form.get('currency') || 'NGN',
      notes: form.get('notes') || undefined,
    }

    const parsed = SubmitPaymentSchema.safeParse(bodyData)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Invalid request' },
        { status: 400 }
      )
    }

    const { invoiceNumber, clientName, amountPaid, currency, notes } =
      parsed.data

    // Fetch invoice
    const invoice = await prisma.invoice.findUnique({
      where: { invoiceNumber },
      include: { user: { select: { id: true, email: true, name: true } } },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    // Validate invoice status
    if (invoice.status !== 'pending') {
      return NextResponse.json(
        { error: `Invoice is already ${invoice.status}` },
        { status: 400 }
      )
    }

    // Check for duplicate submission (within last hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    const existingPayment = await prisma.manualPayment.findFirst({
      where: {
        invoiceId: invoice.id,
        status: 'pending',
        createdAt: { gte: oneHourAgo },
      },
    })

    if (existingPayment) {
      return NextResponse.json(
        {
          error:
            'A payment submission already exists for this invoice. Please wait for verification.',
        },
        { status: 409 }
      )
    }

    // Store receipt file
    let receiptUrl: string
    try {
      receiptUrl = await storeReceiptFile(invoice.id, file)
    } catch (error) {
      console.error('File storage error:', error)
      return NextResponse.json(
        { error: 'Failed to store receipt file' },
        { status: 500 }
      )
    }

    // Create manual payment record
    const manualPayment = await prisma.manualPayment.create({
      data: {
        invoiceId: invoice.id,
        clientName,
        amountPaid: parseFloat(amountPaid),
        currency,
        receiptUrl,
        notes: notes || null,
        status: 'pending',
      },
    })

    // Send notification email to freelancer
    if (invoice.user.email) {
      const { sendManualPaymentNotification } = await import('@/lib/email')
      await sendManualPaymentNotification({
        to: invoice.user.email,
        freelancerName: invoice.user.name || 'Freelancer',
        invoiceNumber: invoice.invoiceNumber,
        clientName,
        amountPaid: parseFloat(amountPaid),
        currency,
        notes,
      }).catch((err) => {
        console.error('Email notification failed:', err)
        // Don't fail the request if email fails
      })
    }

    return NextResponse.json({
      success: true,
      paymentId: manualPayment.id,
      message:
        'Payment proof submitted successfully. The freelancer will verify it shortly.',
    })
  } catch (error) {
    console.error('Manual payment submission error:', error)
    return NextResponse.json(
      { error: 'Failed to submit payment proof' },
      { status: 500 }
    )
  }
}
