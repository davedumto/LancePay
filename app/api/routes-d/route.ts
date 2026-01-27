import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({
    ok: true,
    routes: {
      bulkInvoices: {
        create: '/api/routes-d/bulk-invoices/create',
        uploadCsv: '/api/routes-d/bulk-invoices/upload-csv',
        status: '/api/routes-d/bulk-invoices/status?jobId={id}',
        template: '/api/routes-d/bulk-invoices/template',
      },
      notifications: {
        webhooks: {
          list: '/api/routes-d/notifications/webhooks',
          create: '/api/routes-d/notifications/webhooks',
          delete: '/api/routes-d/notifications/webhooks/{id}',
        },
      },
      branding: {
        get: '/api/routes-d/branding',
        update: '/api/routes-d/branding',
      },
      invoices: {
        list: '/api/routes-d/invoices',
        create: '/api/routes-d/invoices',
        details: '/api/routes-d/invoices/{id}',
        delete: '/api/routes-d/invoices/{id}',
        pdf: '/api/routes-d/invoices/{id}/pdf',
      },
      utils: {
        feeQuote: '/api/routes-d/utils/fee-quote?amount={usd_amount}',
      },
      verification: {
        clientCheck: '/api/routes-d/verification/client-check?email={email}',
      },
    },
  })
}

