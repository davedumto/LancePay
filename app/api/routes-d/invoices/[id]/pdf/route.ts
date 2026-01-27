import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { renderToBuffer } from '@react-pdf/renderer'
import { InvoicePDF } from '@/lib/pdf'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    // Include brandingSettings in the user relation
    const invoice = await prisma.invoice.findFirst({
      where: {
        OR: [
          { id },
          { invoiceNumber: id }
        ]
      },
      include: {
        user: {
          include: {
            brandingSettings: true
          }
        }
      }
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const { user } = invoice

    // Prepare invoice data for PDF
    const invoiceData = {
      invoiceNumber: invoice.invoiceNumber,
      freelancerName: user?.name || 'Freelancer',
      freelancerEmail: user?.email,
      clientName: invoice.clientName || 'Client',
      clientEmail: invoice.clientEmail,
      description: invoice.description,
      amount: Number(invoice.amount),
      currency: invoice.currency,
      status: invoice.status,
      dueDate: invoice.dueDate?.toISOString() || null,
      createdAt: invoice.createdAt.toISOString(),
      paidAt: invoice.paidAt?.toISOString() || null,
      paymentLink: invoice.paymentLink,
    }

    const branding = user?.brandingSettings

    // Generate PDF buffer
    const pdfBuffer = await renderToBuffer(
      InvoicePDF({ 
        invoice: invoiceData,
        branding: branding || undefined
      })
    )

    // Return PDF response (convert Buffer to Uint8Array for NextResponse)
    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${invoice.invoiceNumber}.pdf"`,
      },
    })
  } catch (error) {
    console.error('PDF generation error:', error)
    return NextResponse.json({ error: 'Failed to generate PDF' }, { status: 500 })
  }
}
