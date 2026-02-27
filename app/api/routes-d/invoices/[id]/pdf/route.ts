import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { renderToBuffer } from '@react-pdf/renderer'
import { InvoicePDF, type InvoiceTemplateConfig } from '@/lib/invoice-renderer'
import { getBrandingLogoAbsolutePath } from '@/lib/file-storage'
import { logger } from '@/lib/logger'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    // Include branding settings and invoice templates in the user relation
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
            brandingSettings: true,
            invoiceTemplates: {
              where: { isDefault: true },
              orderBy: { createdAt: 'asc' },
              take: 1,
            },
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

    let template: InvoiceTemplateConfig | undefined

    const defaultTemplate = user?.invoiceTemplates?.[0]

    if (defaultTemplate) {
      const rawLogoUrl = defaultTemplate.logoUrl ?? branding?.logoUrl ?? null
      const logoUrlForPdf =
        rawLogoUrl && rawLogoUrl.startsWith('/branding-logos/')
          ? getBrandingLogoAbsolutePath(rawLogoUrl) ?? rawLogoUrl
          : rawLogoUrl

      template = {
        id: defaultTemplate.id,
        name: defaultTemplate.name,
        logoUrl: logoUrlForPdf,
        primaryColor: defaultTemplate.primaryColor,
        accentColor: defaultTemplate.accentColor,
        showLogo: defaultTemplate.showLogo,
        showFooter: defaultTemplate.showFooter,
        footerText: defaultTemplate.footerText ?? branding?.footerText ?? null,
        layout:
          (defaultTemplate.layout as 'modern' | 'classic' | 'minimal') ?? 'modern',
        signatureUrl: branding?.signatureUrl ?? null,
      }
    } else if (branding) {
      const rawLogoUrl = branding.logoUrl ?? null
      const logoUrlForPdf =
        rawLogoUrl && rawLogoUrl.startsWith('/branding-logos/')
          ? getBrandingLogoAbsolutePath(rawLogoUrl) ?? rawLogoUrl
          : rawLogoUrl

      // Backwards-compatible "implicit" template from branding settings
      template = {
        name: 'Default',
        logoUrl: logoUrlForPdf,
        primaryColor: branding.primaryColor ?? '#000000',
        accentColor: '#059669',
        showLogo: !!branding.logoUrl,
        showFooter: true,
        footerText: branding.footerText ?? null,
        layout: 'modern',
        signatureUrl: branding.signatureUrl ?? null,
      }
    }

    // Generate PDF buffer
    const pdfBuffer = await renderToBuffer(
      InvoicePDF({
        invoice: invoiceData,
        template,
      }),
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
    logger.error({ err: error }, 'PDF generation error:')
    return NextResponse.json({ error: 'Failed to generate PDF' }, { status: 500 })
  }
}
