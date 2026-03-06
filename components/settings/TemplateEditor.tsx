'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePrivy } from '@privy-io/react-auth'

type InvoiceLayout = 'modern' | 'classic' | 'minimal'

type InvoiceTemplate = {
  id: string
  name: string
  isDefault: boolean
  logoUrl: string | null
  primaryColor: string
  accentColor: string
  showLogo: boolean
  showFooter: boolean
  footerText: string | null
  layout: InvoiceLayout
}

type TemplateForm = {
  name: string
  logoUrl: string
  primaryColor: string
  accentColor: string
  showLogo: boolean
  showFooter: boolean
  footerText: string
  layout: InvoiceLayout
  isDefault: boolean
}

const EMPTY_FORM: TemplateForm = {
  name: '',
  logoUrl: '',
  primaryColor: '#000000',
  accentColor: '#059669',
  showLogo: true,
  showFooter: true,
  footerText: '',
  layout: 'modern',
  isDefault: false,
}

function toForm(template: InvoiceTemplate): TemplateForm {
  return {
    name: template.name,
    logoUrl: template.logoUrl || '',
    primaryColor: template.primaryColor,
    accentColor: template.accentColor,
    showLogo: template.showLogo,
    showFooter: template.showFooter,
    footerText: template.footerText || '',
    layout: template.layout,
    isDefault: template.isDefault,
  }
}

export function TemplateEditor() {
  const { getAccessToken } = usePrivy()
  const [templates, setTemplates] = useState<InvoiceTemplate[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [form, setForm] = useState<TemplateForm>(EMPTY_FORM)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedTemplateId) || null,
    [templates, selectedTemplateId],
  )

  const authorizedFetch = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const token = await getAccessToken()
      if (!token) {
        throw new Error('Not authenticated')
      }

      const headers = new Headers(init?.headers)
      headers.set('Authorization', `Bearer ${token}`)

      return fetch(input, { ...init, headers })
    },
    [getAccessToken],
  )

  const loadTemplates = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await authorizedFetch('/api/routes-d/branding/templates')
      const body = await response.json()

      if (!response.ok) {
        throw new Error(body.error || 'Failed to load templates')
      }

      const nextTemplates: InvoiceTemplate[] = body.templates || []
      setTemplates(nextTemplates)

      const nextSelected = nextTemplates.find((template) => template.isDefault) || nextTemplates[0] || null
      if (nextSelected) {
        setSelectedTemplateId(nextSelected.id)
        setForm(toForm(nextSelected))
      } else {
        setSelectedTemplateId(null)
        setForm(EMPTY_FORM)
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load templates')
    } finally {
      setIsLoading(false)
    }
  }, [authorizedFetch])

  useEffect(() => {
    void loadTemplates()
  }, [loadTemplates])

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSuccess(null)
    setIsSaving(true)

    try {
      const payload = {
        name: form.name.trim(),
        logoUrl: form.logoUrl.trim() || null,
        primaryColor: form.primaryColor,
        accentColor: form.accentColor,
        showLogo: form.showLogo,
        showFooter: form.showFooter,
        footerText: form.footerText.trim() || null,
        layout: form.layout,
        isDefault: form.isDefault,
      }

      const endpoint = selectedTemplate
        ? `/api/routes-d/branding/templates/${selectedTemplate.id}`
        : '/api/routes-d/branding/templates'
      const method = selectedTemplate ? 'PUT' : 'POST'

      const response = await authorizedFetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await response.json()

      if (!response.ok) {
        throw new Error(body.message || body.error || 'Failed to save template')
      }

      setSuccess('Template saved')
      await loadTemplates()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to save template')
    } finally {
      setIsSaving(false)
    }
  }

  function onSelectTemplate(template: InvoiceTemplate) {
    setSelectedTemplateId(template.id)
    setForm(toForm(template))
    setError(null)
    setSuccess(null)
  }

  async function onLogoSelected(file: File | null) {
    if (!file) return

    if (file.size > 2 * 1024 * 1024) {
      setError('Logo must be 2MB or less')
      return
    }

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(new Error('Unable to read logo file'))
      reader.readAsDataURL(file)
    })

    setForm((current) => ({ ...current, logoUrl: dataUrl }))
    setError(null)
    setSuccess('Logo ready to save')
  }

  const maxTemplatesReached = templates.length >= 5 && !selectedTemplate

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Invoice Templates</h2>
          <p className="text-sm text-gray-600">Customize logo, colors, footer, and layout.</p>
        </div>
        <button
          type="button"
          disabled={isLoading || templates.length >= 5}
          onClick={() => {
            setSelectedTemplateId(null)
            setForm({ ...EMPTY_FORM, name: `Template ${templates.length + 1}` })
            setError(null)
            setSuccess(null)
          }}
          className="rounded-md bg-black px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          {templates.length >= 5 ? 'Max 5 templates' : 'New template'}
        </button>
      </div>

      {error && <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {success && <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{success}</p>}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              onClick={() => onSelectTemplate(template)}
              className={`w-full rounded-md border p-3 text-left ${
                selectedTemplateId === template.id ? 'border-black' : 'border-gray-200'
              }`}
            >
              <div className="flex items-center justify-between">
                <p className="font-medium">{template.name}</p>
                {template.isDefault && <span className="text-xs text-emerald-700">Default</span>}
              </div>
              <p className="text-xs text-gray-500">{template.layout} layout</p>
            </button>
          ))}
          {!templates.length && !isLoading && (
            <div className="rounded-md border border-dashed border-gray-300 p-4 text-sm text-gray-500">
              No templates yet. Create your first one.
            </div>
          )}
          {isLoading && (
            <div className="rounded-md border border-gray-200 p-4 text-sm text-gray-500">
              Loading templates…
            </div>
          )}
        </div>

        <div className="space-y-4">
          <form onSubmit={onSubmit} className="space-y-4 rounded-md border border-gray-200 p-4">
            <input
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="Template name"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              required
            />

            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">
                Primary color
                <input
                  type="color"
                  value={form.primaryColor}
                  onChange={(event) => setForm((current) => ({ ...current, primaryColor: event.target.value }))}
                  className="mt-1 block h-10 w-full rounded-md border border-gray-300"
                />
              </label>
              <label className="text-sm">
                Accent color
                <input
                  type="color"
                  value={form.accentColor}
                  onChange={(event) => setForm((current) => ({ ...current, accentColor: event.target.value }))}
                  className="mt-1 block h-10 w-full rounded-md border border-gray-300"
                />
              </label>
            </div>

            <label className="block text-sm">
              Logo upload (max 2MB)
              <input
                type="file"
                accept="image/*"
                onChange={(event) => void onLogoSelected(event.target.files?.[0] || null)}
                className="mt-1 block w-full text-sm"
              />
            </label>

            <textarea
              value={form.footerText}
              onChange={(event) => setForm((current) => ({ ...current, footerText: event.target.value }))}
              placeholder="Footer text"
              rows={3}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />

            <select
              value={form.layout}
              onChange={(event) => setForm((current) => ({ ...current, layout: event.target.value as InvoiceLayout }))}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="modern">Modern</option>
              <option value="classic">Classic</option>
              <option value="minimal">Minimal</option>
            </select>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.isDefault}
                onChange={(event) => setForm((current) => ({ ...current, isDefault: event.target.checked }))}
              />
              Set as default template
            </label>

            <button
              type="submit"
              disabled={isSaving || maxTemplatesReached}
              className="rounded-md bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {isSaving ? 'Saving…' : 'Save template'}
            </button>
          </form>

          <div className="rounded-md border border-gray-200 p-4">
            <p className="mb-2 text-xs uppercase text-gray-500">Live preview</p>
            <div className="rounded-md border p-4" style={{ borderColor: form.primaryColor }}>
              <div className="mb-3 flex items-center justify-between">
                <div className="text-sm font-semibold" style={{ color: form.accentColor }}>
                  {form.showLogo ? (form.name || 'Your Brand') : 'Invoice'}
                </div>
                <div className="text-xs text-gray-600">Invoice #12345</div>
              </div>
              <p className="text-sm">Bill To: client@company.com</p>
              <p className="text-sm">Amount: $500.00</p>
              <p className="text-sm">Due: Jan 30, 2026</p>
              {form.showFooter && (
                <p className="mt-4 text-xs text-gray-500">
                  {form.footerText || 'Thank you for your business! Net 30 terms apply.'}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

