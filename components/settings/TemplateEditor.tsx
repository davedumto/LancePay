'use client'

import { useEffect, useState, useRef } from 'react'
import { usePrivy } from '@privy-io/react-auth'

type LayoutType = 'modern' | 'classic' | 'minimal'

export interface InvoiceTemplate {
  id: string
  userId: string
  name: string
  isDefault: boolean
  logoUrl: string | null
  primaryColor: string
  accentColor: string
  showLogo: boolean
  showFooter: boolean
  footerText: string | null
  layout: LayoutType
  createdAt: string
  updatedAt: string
}

interface TemplateFormState {
  name: string
  logoUrl: string
  primaryColor: string
  accentColor: string
  showLogo: boolean
  showFooter: boolean
  footerText: string
  layout: LayoutType
  isDefault: boolean
}

const EMPTY_FORM: TemplateFormState = {
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

export function TemplateEditor() {
  const { getAccessToken } = usePrivy()

  const [templates, setTemplates] = useState<InvoiceTemplate[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [form, setForm] = useState<TemplateFormState>(EMPTY_FORM)
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null)
  const logoPreviewUrlRef = useRef<string | null>(null)

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) || null

  useEffect(() => {
    void loadTemplates()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Resolve logo URL for preview: external URLs work as-is; /branding-logos/... must be fetched with auth
  useEffect(() => {
    const url = form.logoUrl?.trim() || null
    if (!url) {
      if (logoPreviewUrlRef.current) {
        URL.revokeObjectURL(logoPreviewUrlRef.current)
        logoPreviewUrlRef.current = null
      }
      setLogoPreviewUrl(null)
      return
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      if (logoPreviewUrlRef.current) {
        URL.revokeObjectURL(logoPreviewUrlRef.current)
        logoPreviewUrlRef.current = null
      }
      setLogoPreviewUrl(url)
      return
    }
    if (url.startsWith('/branding-logos/')) {
      const pathPart = url.replace(/^\/branding-logos\//, '')
      getAccessToken().then((token) => {
        if (!token) {
          setLogoPreviewUrl(null)
          return
        }
        fetch(`/api/routes-d/branding/logo?path=${encodeURIComponent(pathPart)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
          .then((r) => (r.ok ? r.blob() : null))
          .then((blob) => {
            if (logoPreviewUrlRef.current) {
              URL.revokeObjectURL(logoPreviewUrlRef.current)
              logoPreviewUrlRef.current = null
            }
            if (blob) {
              const objUrl = URL.createObjectURL(blob)
              logoPreviewUrlRef.current = objUrl
              setLogoPreviewUrl(objUrl)
            } else {
              setLogoPreviewUrl(null)
            }
          })
          .catch(() => setLogoPreviewUrl(null))
      })
      return
    }
    setLogoPreviewUrl(null)
  }, [form.logoUrl, getAccessToken])

  useEffect(() => {
    return () => {
      if (logoPreviewUrlRef.current) {
        URL.revokeObjectURL(logoPreviewUrlRef.current)
      }
    }
  }, [])

  async function authorizedFetch(input: RequestInfo, init?: RequestInit) {
    const token = await getAccessToken()
    if (!token) throw new Error('Not authenticated')

    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${token}`)

    return fetch(input, {
      ...init,
      headers,
    })
  }

  async function loadTemplates() {
    try {
      setLoading(true)
      setError(null)

      const res = await authorizedFetch('/api/routes-d/branding/templates')
      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Failed to load templates')
      }

      const loaded: InvoiceTemplate[] = data.templates || []
      setTemplates(loaded)

      const defaultTemplate = loaded.find((t) => t.isDefault) || loaded[0]
      if (defaultTemplate) {
        setSelectedTemplateId(defaultTemplate.id)
        setForm(fromTemplate(defaultTemplate))
      } else {
        setSelectedTemplateId(null)
        setForm(EMPTY_FORM)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load templates')
    } finally {
      setLoading(false)
    }
  }

  function fromTemplate(template: InvoiceTemplate): TemplateFormState {
    return {
      name: template.name,
      logoUrl: template.logoUrl || '',
      primaryColor: template.primaryColor || '#000000',
      accentColor: template.accentColor || '#059669',
      showLogo: template.showLogo,
      showFooter: template.showFooter,
      footerText: template.footerText || '',
      layout: (template.layout as LayoutType) || 'modern',
      isDefault: template.isDefault,
    }
  }

  function handleFieldChange<K extends keyof TemplateFormState>(
    key: K,
    value: TemplateFormState[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }))
    setSuccess(null)
  }

  function handleNewTemplate() {
    setSelectedTemplateId(null)
    setForm({
      ...EMPTY_FORM,
      name: `Template ${templates.length + 1}`,
    })
    setSuccess(null)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setSuccess(null)

    try {
      const payload = {
        name: form.name.trim(),
        logoUrl: form.logoUrl || null,
        primaryColor: form.primaryColor,
        accentColor: form.accentColor,
        showLogo: form.showLogo,
        showFooter: form.showFooter,
        footerText: form.footerText.trim() || null,
        layout: form.layout,
        isDefault: form.isDefault,
      }

      let res: Response
      if (selectedTemplateId) {
        res = await authorizedFetch(
          `/api/routes-d/branding/templates/${selectedTemplateId}`,
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          },
        )
      } else {
        res = await authorizedFetch('/api/routes-d/branding/templates', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        })
      }

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to save template')
      }

      await loadTemplates()
      setSuccess('Template saved')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save template')
    } finally {
      setSaving(false)
    }
  }

  async function handleSetDefault(id: string) {
    try {
      setSaving(true)
      setError(null)
      setSuccess(null)

      const res = await authorizedFetch(`/api/routes-d/branding/templates/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isDefault: true }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to set default template')
      }

      await loadTemplates()
      setSuccess('Default template updated')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set default template')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this template? This cannot be undone.')) return

    try {
      setSaving(true)
      setError(null)
      setSuccess(null)

      const res = await authorizedFetch(`/api/routes-d/branding/templates/${id}`, {
        method: 'DELETE',
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to delete template')
      }

      await loadTemplates()
      setSuccess('Template deleted')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete template')
    } finally {
      setSaving(false)
    }
  }

  async function handleLogoUpload(file: File | null) {
    if (!file) return

    try {
      setUploadingLogo(true)
      setError(null)
      setSuccess(null)

      if (file.size > 2 * 1024 * 1024) {
        throw new Error('Logo too large (max 2MB)')
      }

      const formData = new FormData()
      formData.append('logo', file)

      const res = await authorizedFetch('/api/routes-d/branding/logo-upload', {
        method: 'POST',
        body: formData,
      })
      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to upload logo')
      }

      if (typeof data.logoUrl === 'string') {
        setForm((prev) => ({ ...prev, logoUrl: data.logoUrl }))
        setSuccess('Logo uploaded')
      } else {
        throw new Error('Upload response did not include logoUrl')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload logo')
    } finally {
      setUploadingLogo(false)
    }
  }

  const maxTemplatesReached = templates.length >= 5

  const previewPrimary = form.primaryColor || '#111827'
  const previewAccent = form.accentColor || '#059669'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-brand-black">
            Invoice Templates
          </h2>
          <p className="text-sm text-brand-gray">
            Create reusable invoice layouts with your logo, colors, and footer copy.
          </p>
        </div>
        <button
          type="button"
          onClick={handleNewTemplate}
          disabled={maxTemplatesReached || loading}
          className="px-4 py-2 rounded-lg bg-brand-black text-white text-sm font-medium disabled:opacity-50"
        >
          {maxTemplatesReached ? 'Max 5 templates' : 'New Template'}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {success && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
          {success}
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)]">
        {/* Templates list */}
        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs text-brand-gray">
            <span>
              {templates.length} / 5 templates used
            </span>
          </div>

          {loading && (
            <div className="rounded-lg border border-brand-border bg-brand-light px-4 py-3 text-sm text-brand-gray">
              Loading templates…
            </div>
          )}

          {!loading && templates.length === 0 && (
            <div className="rounded-lg border border-dashed border-brand-border px-4 py-6 text-sm text-brand-gray">
              No templates yet. Create your first branded invoice template.
            </div>
          )}

          <div className="space-y-3">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setSelectedTemplateId(t.id)
                  setForm(fromTemplate(t))
                  setSuccess(null)
                }}
                className={`w-full rounded-lg border px-4 py-3 text-left transition-colors ${
                  selectedTemplateId === t.id
                    ? 'border-brand-black bg-brand-light'
                    : 'border-brand-border hover:border-brand-black/60'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-brand-black">
                        {t.name}
                      </span>
                      {t.isDefault && (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                          Default
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-brand-gray">
                      <span className="rounded-full bg-gray-100 px-2 py-0.5">
                        {t.layout}
                      </span>
                      <span
                        className="h-4 w-4 rounded-full border"
                        style={{ backgroundColor: t.primaryColor }}
                      />
                      <span
                        className="h-4 w-4 rounded-full border"
                        style={{ backgroundColor: t.accentColor }}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 text-xs">
                    {!t.isDefault && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleSetDefault(t.id)
                        }}
                        className="rounded-full border border-brand-border px-2 py-0.5 text-[11px] text-brand-black hover:bg-brand-light"
                      >
                        Set default
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleDelete(t.id)
                      }}
                      className="text-[11px] text-red-500 hover:underline"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Editor + live preview */}
        <div className="space-y-4">
          <form onSubmit={handleSave} className="space-y-4 rounded-xl border border-brand-border bg-white p-4 shadow-sm">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="block text-xs font-medium text-brand-gray uppercase tracking-wide">
                  Template name
                </label>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => handleFieldChange('name', e.target.value)}
                  className="w-full rounded-lg border border-brand-border px-3 py-2 text-sm outline-none focus:border-brand-black"
                  placeholder="Client-ready invoice"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-xs font-medium text-brand-gray uppercase tracking-wide">
                  Layout
                </label>
                <select
                  value={form.layout}
                  onChange={(e) => handleFieldChange('layout', e.target.value as LayoutType)}
                  className="w-full rounded-lg border border-brand-border bg-white px-3 py-2 text-sm outline-none focus:border-brand-black"
                >
                  <option value="modern">Modern</option>
                  <option value="classic">Classic</option>
                  <option value="minimal">Minimal</option>
                </select>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="block text-xs font-medium text-brand-gray uppercase tracking-wide">
                  Primary color
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={form.primaryColor}
                    onChange={(e) => handleFieldChange('primaryColor', e.target.value)}
                    className="h-9 w-9 cursor-pointer rounded border border-brand-border bg-transparent"
                  />
                  <input
                    type="text"
                    value={form.primaryColor}
                    onChange={(e) => handleFieldChange('primaryColor', e.target.value)}
                    className="flex-1 rounded-lg border border-brand-border px-3 py-2 text-sm font-mono outline-none focus:border-brand-black"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-xs font-medium text-brand-gray uppercase tracking-wide">
                  Accent color
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={form.accentColor}
                    onChange={(e) => handleFieldChange('accentColor', e.target.value)}
                    className="h-9 w-9 cursor-pointer rounded border border-brand-border bg-transparent"
                  />
                  <input
                    type="text"
                    value={form.accentColor}
                    onChange={(e) => handleFieldChange('accentColor', e.target.value)}
                    className="flex-1 rounded-lg border border-brand-border px-3 py-2 text-sm font-mono outline-none focus:border-brand-black"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-medium text-brand-gray uppercase tracking-wide">
                Logo
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => void handleLogoUpload(e.target.files?.[0] || null)}
                  className="text-xs"
                />
                <span className="text-xs text-brand-gray">
                  Max 2MB • JPG, PNG, WEBP, HEIC
                </span>
                {uploadingLogo && (
                  <span className="text-xs text-brand-gray">Uploading…</span>
                )}
              </div>
              {form.logoUrl && (
                <div className="mt-2 flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded border border-brand-border bg-white">
                    {logoPreviewUrl && (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={logoPreviewUrl}
                        alt="Logo preview"
                        className="max-h-full max-w-full object-contain"
                      />
                    )}
                  </div>
                  <span className="truncate text-xs text-brand-gray">
                    {form.logoUrl}
                  </span>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-medium text-brand-gray uppercase tracking-wide">
                Footer text
              </label>
              <textarea
                value={form.footerText}
                onChange={(e) => handleFieldChange('footerText', e.target.value)}
                rows={3}
                className="w-full resize-none rounded-lg border border-brand-border px-3 py-2 text-sm outline-none focus:border-brand-black"
                placeholder='e.g. "Thank you for your business! Net 30 terms apply."'
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-brand-border pt-3">
              <div className="flex flex-wrap items-center gap-4 text-xs text-brand-gray">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.showLogo}
                    onChange={(e) => handleFieldChange('showLogo', e.target.checked)}
                    className="h-4 w-4 rounded border-brand-border text-brand-black focus:ring-brand-black"
                  />
                  <span>Show logo</span>
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.showFooter}
                    onChange={(e) => handleFieldChange('showFooter', e.target.checked)}
                    className="h-4 w-4 rounded border-brand-border text-brand-black focus:ring-brand-black"
                  />
                  <span>Show footer</span>
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.isDefault}
                    onChange={(e) => handleFieldChange('isDefault', e.target.checked)}
                    className="h-4 w-4 rounded border-brand-border text-brand-black focus:ring-brand-black"
                  />
                  <span>Use as default for new invoices</span>
                </label>
              </div>

              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center justify-center rounded-lg bg-brand-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save Template'}
              </button>
            </div>
          </form>

          {/* Live preview */}
          <div className="rounded-xl border border-dashed border-brand-border bg-gray-50 p-4">
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-brand-gray">
              Live preview
            </p>
            <div className="overflow-hidden rounded-xl bg-white shadow-sm">
              <div
                className="border-b px-5 py-4"
                style={{
                  borderColor: previewPrimary,
                  background:
                    form.layout === 'classic'
                      ? '#f9fafb'
                      : form.layout === 'minimal'
                      ? '#ffffff'
                      : 'linear-gradient(90deg, rgba(15,23,42,0.96), rgba(15,118,110,0.9))',
                  color: form.layout === 'modern' ? '#f9fafb' : '#111827',
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    {form.showLogo && (form.logoUrl && logoPreviewUrl) ? (
                      <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded bg-white/10">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={logoPreviewUrl}
                          alt="Logo"
                          className="max-h-full max-w-full object-contain"
                        />
                      </div>
                    ) : (
                      <div className="text-sm font-semibold">
                        {form.name || 'Your brand'}
                      </div>
                    )}
                  </div>
                  <div className="text-right text-xs">
                    <div className="font-semibold">Invoice #12345</div>
                    <div className="text-[11px] opacity-80">Due Jan 30, 2026</div>
                  </div>
                </div>
              </div>

              <div className="space-y-4 px-5 py-4 text-xs text-slate-800">
                <div className="flex justify-between gap-4">
                  <div>
                    <div className="text-[11px] font-semibold uppercase text-slate-500">
                      Bill To
                    </div>
                    <div className="mt-1 text-sm font-medium">
                      client@company.com
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[11px] font-semibold uppercase text-slate-500">
                      Amount
                    </div>
                    <div className="mt-1 text-lg font-semibold">
                      $500.00 <span className="text-[11px] text-slate-500">USDC</span>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg bg-slate-50 px-4 py-3 text-[11px] text-slate-600">
                  <div className="mb-1 font-semibold uppercase tracking-wide text-slate-500">
                    Description
                  </div>
                  <p>Design & development services for January 2026.</p>
                </div>

                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-xs font-medium text-white shadow-sm"
                  style={{ backgroundColor: previewAccent }}
                >
                  Pay with USDC
                </button>

                {form.showFooter && (form.footerText || selectedTemplate) && (
                  <div className="mt-2 border-t border-slate-100 pt-3 text-[11px] text-slate-500">
                    <div>
                      {form.footerText ||
                        'Thank you for your business! Net 30 terms apply.'}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

