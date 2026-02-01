'use client'

import { useState } from 'react'
import { Plus, AlertTriangle, Loader2 } from 'lucide-react'

export function TrustlineManager({ onUpdate }: { onUpdate?: () => void }) {
    const [isOpen, setIsOpen] = useState(false)
    const [assetCode, setAssetCode] = useState('')
    const [assetIssuer, setAssetIssuer] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [message, setMessage] = useState<{ type: 'error' | 'success', text: string } | null>(null)

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setIsLoading(true)
        setMessage(null)

        try {
            const token = localStorage.getItem('privy:token')?.replace('"', '').replace('"', '')
            // Note: In real app, use usePrivy() to get token properly

            const res = await fetch('/api/user/trustlines', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ assetCode, assetIssuer })
            })

            const data = await res.json()

            if (!res.ok) {
                throw new Error(data.error || 'Failed to add trustline')
            }

            setMessage({ type: 'success', text: 'Trustline added successfully!' })
            setAssetCode('')
            setAssetIssuer('')
            if (onUpdate) onUpdate()
            setTimeout(() => setIsOpen(false), 2000)
        } catch (err: any) {
            setMessage({ type: 'error', text: err.message })
        } finally {
            setIsLoading(false)
        }
    }

    if (!isOpen) {
        return (
            <button
                onClick={() => setIsOpen(true)}
                className="mt-4 flex items-center gap-2 text-sm text-brand-primary font-medium hover:text-brand-primary/80 transition-colors"
            >
                <Plus className="w-4 h-4" />
                Add Asset Trustline
            </button>
        )
    }

    return (
        <div className="mt-4 bg-gray-50 rounded-xl p-4 border border-gray-200">
            <div className="flex justify-between items-center mb-4">
                <h4 className="font-semibold text-brand-black">Add Asset</h4>
                <button
                    onClick={() => setIsOpen(false)}
                    className="text-gray-400 hover:text-brand-black"
                >
                    Cancel
                </button>
            </div>

            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-4 flex gap-2">
                <AlertTriangle className="w-5 h-5 text-yellow-600 shrink-0" />
                <p className="text-xs text-yellow-700">
                    Adding a trustline requires locking 0.5 XLM as current base reserve. ensure you have sufficient XLM balance.
                </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-3">
                <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Asset Code</label>
                    <input
                        type="text"
                        value={assetCode}
                        onChange={(e) => setAssetCode(e.target.value.toUpperCase())}
                        placeholder="e.g. AQUA"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20"
                        required
                        maxLength={12}
                    />
                </div>

                <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Asset Issuer</label>
                    <input
                        type="text"
                        value={assetIssuer}
                        onChange={(e) => setAssetIssuer(e.target.value)}
                        placeholder="G..."
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20"
                        required
                        minLength={56}
                        maxLength={56}
                    />
                </div>

                {message && (
                    <div className={`text-xs p-2 rounded ${message.type === 'error' ? 'text-red-600 bg-red-50' : 'text-green-600 bg-green-50'}`}>
                        {message.text}
                    </div>
                )}

                <button
                    type="submit"
                    disabled={isLoading}
                    className="w-full bg-brand-primary text-white py-2 rounded-lg text-sm font-medium hover:bg-brand-primary/90 transition-colors flex items-center justify-center gap-2"
                >
                    {isLoading ? (
                        <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Adding...
                        </>
                    ) : (
                        'Confirm Trustline'
                    )}
                </button>
            </form>

            <div className="mt-6 border-t border-gray-100 pt-4">
                <h5 className="text-xs font-semibold text-brand-gray mb-3 uppercase tracking-wider">Popular Assets</h5>
                <div className="grid grid-cols-2 gap-2">
                    {[
                        { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', name: 'USD Coin' },
                        { code: 'yXLM', issuer: 'GARDNV3Q7YGT4GLTH3CPFKDSOWOKTTX4A6HPXJXIWMEE2J0M53JGEURE', name: 'Yield XLM' },
                        { code: 'AQUA', issuer: 'GBNZ7527G4WS3I334H334H334H334H334H334H334H334H334H334H33', name: 'Aquarius' },
                        { code: 'ARST', issuer: 'GC42A96M3I96W3I96W3I96W3I96W3I96W3I96W3I96W3I96W3I96W3I9', name: 'Argentine Peso' },
                    ].map((asset) => (
                        <button
                            key={asset.code}
                            onClick={() => {
                                setAssetCode(asset.code)
                                setAssetIssuer(asset.issuer)
                            }}
                            className="text-left p-2 rounded-lg hover:bg-gray-100 border border-transparent hover:border-gray-200 transition-all group"
                        >
                            <div className="font-medium text-sm text-brand-black">{asset.code}</div>
                            <div className="text-[10px] text-gray-400 group-hover:text-gray-500 truncate">{asset.name}</div>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    )
}
