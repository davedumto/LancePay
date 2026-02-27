'use client'

import { useState, useEffect } from 'react'
import { usePrivy } from '@privy-io/react-auth'
import { Plus, Trash2, Star, Loader2 } from 'lucide-react'

interface InvoiceTemplate {
  id: string
  name: string
  isDefault: boolean
  logoUrl?: string | null
  primaryColor: string
  accentColor: string
  showLogo: boolean
  showFooter: boolean
  footerText?: string | null
  layout: 'modern' | 'classic' | 'minimal'
}

const defaultTemplate: Omit<InvoiceTemplate, 'id'> = {
  name: 'New Template',
  isDefault: false,
  logoUrl: null,
  primaryColor: '#000000',
  accentColor: '#6366f1',
  showLogo: true,
  showFooter: true,
  footerText: 'Thank you for your business!',
  layout: 'modern',
}

export function InvoiceTemplateEditor() {
  const { getAccessToken } = usePrivy()
  const [templates, setTemplates] = useState<InvoiceTemplate[]>([])
  const [selected, setSelected] = useState<InvoiceTemplate | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => { fetchTemplates() }, [])

  const fetchTemplates = async () => {
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/routes-d/invoice-templates', {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()
      setTemplates(data.templates || [])
      if (data.templates?.length > 0) setSelected(data.templates[0])
    } catch { setError('Failed to load templates') }
    finally { setLoading(false) }
  }

  const createTemplate = async () => {
    if (templates.length >= 5) { setError('Maximum 5 templates allowed'); return }
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/routes-d/invoice-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(defaultTemplate)
      })
      const data = await res.json()
      setTemplates(prev => [...prev, data.template])
      setSelected(data.template)
    } catch { setError('Failed to create template') }
  }

  const saveTemplate = async () => {
    if (!selected) return
    setSaving(true)
    setError('')
    try {
      const token = await getAccessToken()
      const res = await fetch(`/api/routes-d/invoice-templates/${selected.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(selected)
      })
      const data = await res.json()
      setTemplates(prev => prev.map(t => t.id === data.template.id ? data.template : t))
      setSelected(data.template)
      setSuccess('Template saved!')
      setTimeout(() => setSuccess(''), 3000)
    } catch { setError('Failed to save template') }
    finally { setSaving(false) }
  }

  const deleteTemplate = async (id: string) => {
    try {
      const token = await getAccessToken()
      await fetch(`/api/routes-d/invoice-templates/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      })
      const updated = templates.filter(t => t.id !== id)
      setTemplates(updated)
      setSelected(updated[0] || null)
    } catch { setError('Failed to delete template') }
  }

  if (loading) return <div className="flex justify-center p-8"><Loader2 className="animate-spin w-6 h-6" /></div>

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Template List */}
      <div className="space-y-3">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-brand-black">Templates ({templates.length}/5)</h3>
          <button onClick={createTemplate} disabled={templates.length >= 5}
            className="flex items-center gap-1 text-sm px-3 py-1.5 bg-brand-black text-white rounded-lg hover:bg-gray-800 disabled:opacity-50">
            <Plus className="w-3.5 h-3.5" /> New
          </button>
        </div>
        {templates.map(t => (
          <div key={t.id} onClick={() => setSelected(t)}
            className={`p-3 rounded-lg border cursor-pointer transition-colors ${selected?.id === t.id ? 'border-brand-black bg-brand-light' : 'border-brand-border hover:border-brand-black/30'}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full border" style={{ backgroundColor: t.primaryColor }} />
                <span className="text-sm font-medium">{t.name}</span>
                {t.isDefault && <Star className="w-3 h-3 text-yellow-500 fill-yellow-500" />}
              </div>
              <button onClick={(e) => { e.stopPropagation(); deleteTemplate(t.id) }}
                className="p-1 text-gray-400 hover:text-red-500 transition-colors">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-xs text-brand-gray mt-1 capitalize">{t.layout} layout</p>
          </div>
        ))}
        {templates.length === 0 && (
          <p className="text-sm text-brand-gray text-center py-4">No templates yet. Create one!</p>
        )}
      </div>

      {/* Template Editor */}
      {selected && (
        <div className="lg:col-span-2 space-y-6">
          {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">{error}</div>}
          {success && <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-600 text-sm">{success}</div>}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Template Name</label>
              <input type="text" value={selected.name}
                onChange={e => setSelected(prev => prev ? { ...prev, name: e.target.value } : null)}
                className="w-full px-3 py-2 rounded-lg border border-brand-border focus:border-brand-black outline-none text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Layout</label>
              <select value={selected.layout}
                onChange={e => setSelected(prev => prev ? { ...prev, layout: e.target.value as 'modern' | 'classic' | 'minimal' } : null)}
                className="w-full px-3 py-2 rounded-lg border border-brand-border focus:border-brand-black outline-none text-sm bg-white">
                <option value="modern">Modern</option>
                <option value="classic">Classic</option>
                <option value="minimal">Minimal</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Primary Color</label>
              <div className="flex gap-2 items-center">
                <input type="color" value={selected.primaryColor}
                  onChange={e => setSelected(prev => prev ? { ...prev, primaryColor: e.target.value } : null)}
                  className="w-10 h-10 rounded border cursor-pointer" />
                <input type="text" value={selected.primaryColor}
                  onChange={e => setSelected(prev => prev ? { ...prev, primaryColor: e.target.value } : null)}
                  className="flex-1 px-3 py-2 rounded-lg border border-brand-border outline-none text-sm font-mono" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Accent Color</label>
              <div className="flex gap-2 items-center">
                <input type="color" value={selected.accentColor}
                  onChange={e => setSelected(prev => prev ? { ...prev, accentColor: e.target.value } : null)}
                  className="w-10 h-10 rounded border cursor-pointer" />
                <input type="text" value={selected.accentColor}
                  onChange={e => setSelected(prev => prev ? { ...prev, accentColor: e.target.value } : null)}
                  className="flex-1 px-3 py-2 rounded-lg border border-brand-border outline-none text-sm font-mono" />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Logo URL</label>
            <input type="url" value={selected.logoUrl || ''}
              onChange={e => setSelected(prev => prev ? { ...prev, logoUrl: e.target.value || null } : null)}
              className="w-full px-3 py-2 rounded-lg border border-brand-border focus:border-brand-black outline-none text-sm"
              placeholder="https://example.com/logo.png" />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Footer Text</label>
            <input type="text" value={selected.footerText || ''}
              onChange={e => setSelected(prev => prev ? { ...prev, footerText: e.target.value || null } : null)}
              className="w-full px-3 py-2 rounded-lg border border-brand-border focus:border-brand-black outline-none text-sm"
              placeholder="Thank you for your business!" />
          </div>

          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={selected.showLogo}
                onChange={e => setSelected(prev => prev ? { ...prev, showLogo: e.target.checked } : null)}
                className="w-4 h-4 rounded" />
              <span className="text-sm">Show Logo</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={selected.showFooter}
                onChange={e => setSelected(prev => prev ? { ...prev, showFooter: e.target.checked } : null)}
                className="w-4 h-4 rounded" />
              <span className="text-sm">Show Footer</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={selected.isDefault}
                onChange={e => setSelected(prev => prev ? { ...prev, isDefault: e.target.checked } : null)}
                className="w-4 h-4 rounded" />
              <span className="text-sm">Set as Default</span>
            </label>
          </div>

          {/* Preview */}
          <div className="border rounded-lg p-4 bg-gray-50">
            <p className="text-xs font-medium text-brand-gray mb-3 uppercase tracking-wide">Preview</p>
            <div className="bg-white rounded border p-4 max-w-sm" style={{ borderColor: selected.primaryColor }}>
              {selected.showLogo && selected.logoUrl && (
                <img src={selected.logoUrl} alt="Logo" className="h-8 mb-3 object-contain" />
              )}
              <div className="flex justify-between items-start mb-4">
                <div>
                  <p className="font-bold" style={{ color: selected.primaryColor }}>Invoice #12345</p>
                  <p className="text-xs text-gray-500">Due: Jan 30, 2026</p>
                </div>
                <p className="text-xl font-bold" style={{ color: selected.accentColor }}>$500.00</p>
              </div>
              <p className="text-xs text-gray-600 mb-3">Bill To: client@company.com</p>
              <button className="w-full py-2 rounded text-white text-sm font-medium"
                style={{ backgroundColor: selected.accentColor }}>
                Pay with USDC
              </button>
              {selected.showFooter && selected.footerText && (
                <p className="text-xs text-gray-400 text-center mt-3">{selected.footerText}</p>
              )}
            </div>
          </div>

          <button onClick={saveTemplate} disabled={saving}
            className="w-full py-3 bg-brand-black text-white rounded-lg font-medium hover:bg-gray-800 transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
            {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving...</> : 'Save Template'}
          </button>
        </div>
      )}
    </div>
  )
}
