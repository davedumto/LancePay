import { NextRequest, NextResponse } from 'next/server'
import { withBodyLimit } from '../../_lib/with-body-limit'
import { withRequestId } from '../../_lib/with-request-id'
import { registerRoute } from '../../_lib/openapi'
import { errorResponse } from '../../_lib/errors'
import { verifyAuthToken } from '@/lib/auth'
import { brandingSchema } from '../schema'

registerRoute({
  method: 'POST',
  path: '/branding/preview',
  summary: 'Preview branding settings',
  description:
    'Validate a candidate branding payload and render a small inline HTML preview without persisting changes.',
  requestSchema: brandingSchema,
  responseSchema: { html: 'string' } as unknown,
  tags: ['branding'],
})

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildPreviewHtml(branding: Record<string, string | null | undefined>) {
  const primaryColor = branding.primaryColor ?? '#6366f1'
  const secondaryColor = branding.secondaryColor ?? '#eef2ff'
  const accentColor = branding.accentColor ?? '#2563eb'
  const logoUrl = branding.logoUrl ? escapeHtml(branding.logoUrl) : null
  const footerText = branding.footerText ? escapeHtml(branding.footerText) : ''

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Branding Preview</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #f8fafc; color: #0f172a; }
      .preview { max-width: 600px; margin: 24px auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; box-shadow: 0 12px 40px rgba(15, 23, 42, 0.08); }
      .header { display: flex; align-items: center; justify-content: space-between; background: ${primaryColor}; color: white; padding: 20px; gap: 16px; }
      .header-branding { display: flex; flex-direction: column; gap: 4px; }
      .header-title { margin: 0; font-size: 1rem; letter-spacing: 0.03em; text-transform: uppercase; font-weight: 700; }
      .header-subtitle { margin: 0; font-size: 1.3rem; }
      .logo { max-height: 48px; max-width: 160px; object-fit: contain; border-radius: 8px; background: white; padding: 8px; }
      .invoice-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; padding: 20px; background: ${secondaryColor}; }
      .invoice-meta div { padding: 16px; border-radius: 12px; background: white; }
      .label { margin: 0 0 8px 0; font-size: 0.8rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em; }
      .value { margin: 0; font-size: 1.1rem; font-weight: 600; }
      .line-items { padding: 20px; }
      .line-item { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
      .line-item:last-child { margin-bottom: 0; }
      .legend { display: inline-flex; align-items: center; gap: 8px; margin-top: 16px; font-size: 0.9rem; color: #475569; }
      .chip { display: inline-flex; align-items: center; justify-content: center; width: 12px; height: 12px; border-radius: 9999px; }
      .footer { padding: 20px; background: #ffffff; border-top: 1px solid #e2e8f0; color: #475569; }
      .accent { color: ${accentColor}; }
    </style>
  </head>
  <body>
    <div class="preview">
      <div class="header">
        <div class="header-branding">
          <p class="header-title">Invoice Preview</p>
          <h1 class="header-subtitle">Acme Corporation</h1>
        </div>
        ${logoUrl ? `<img class="logo" src="${logoUrl}" alt="Logo preview" />` : ''}
      </div>
      <div class="invoice-meta">
        <div>
          <p class="label">Invoice #</p>
          <p class="value">12345</p>
        </div>
        <div>
          <p class="label">Due date</p>
          <p class="value">2026-06-30</p>
        </div>
      </div>
      <div class="line-items">
        <div class="line-item">
          <span>Consulting Services</span>
          <span class="accent">$1,250.00</span>
        </div>
        <div class="line-item">
          <span>Platform fee</span>
          <span class="accent">$120.00</span>
        </div>
      </div>
      <div class="footer">
        <p class="legend">Sample branding uses primary color <span class="chip" style="background:${primaryColor}"></span> and accent <span class="chip" style="background:${accentColor}"></span>.</p>
        ${footerText ? `<p>${footerText}</p>` : ''}
      </div>
    </div>
  </body>
</html>`
}

async function POSTHandler(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return errorResponse('UNAUTHORIZED', 'Unauthorized', {}, 401)
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return errorResponse('UNAUTHORIZED', 'Unauthorized', {}, 401)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse('BAD_REQUEST', 'Invalid request body', { fields: { body: 'Invalid JSON' } }, 422)
  }

  const parsed = brandingSchema.safeParse(body)
  if (!parsed.success) {
    const fields = parsed.error.issues.reduce<Record<string, string>>((result, issue) => {
      const key = typeof issue.path[0] === 'string' ? issue.path[0] : 'body'
      if (!result[key]) result[key] = issue.message
      return result
    }, {})

    return errorResponse('BAD_REQUEST', 'Invalid branding payload', { fields }, 422)
  }

  const html = buildPreviewHtml(parsed.data)
  return new NextResponse(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  })
}

export const POST = withRequestId(withBodyLimit(POSTHandler, { limitBytes: 1024 * 1024 }))
