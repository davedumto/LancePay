/* eslint-disable @next/next/no-img-element */
import { AssetMetadata } from '@/lib/assets';

interface AssetListProps {
    assets: {
        code: string;
        issuer?: string;
        balance: string;
        value: number;
        metadata: AssetMetadata;
    }[];
    currency: string;
}

export function AssetList({ assets, currency }: AssetListProps) {
    if (!assets || assets.length === 0) {
        return (
            <div className="bg-white rounded-2xl border border-brand-border p-6 mt-6">
                <p className="text-gray-500 text-center">No assets found</p>
            </div>
        );
    }

    return (
        <div className="bg-white rounded-2xl border border-brand-border p-6 mt-6">
            <h3 className="text-lg font-bold text-brand-black mb-4">Your Assets</h3>
            <div className="space-y-4">
                {assets.map((asset, index) => (
                    <div
                        key={`${asset.code}-${asset.issuer || 'native'}`}
                        className="flex items-center justify-between p-3 rounded-xl hover:bg-gray-50 transition-colors"
                    >
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center overflow-hidden">
                                {asset.metadata.icon ? (
                                    <img
                                        src={asset.metadata.icon}
                                        alt={asset.metadata.name}
                                        className="w-full h-full object-cover"
                                    />
                                ) : (
                                    <span className="text-sm font-bold text-gray-400">
                                        {asset.code.substring(0, 2)}
                                    </span>
                                )}
                            </div>
                            <div>
                                <div className="font-semibold text-brand-black flex items-center gap-1">
                                    {asset.metadata.name}
                                    {asset.metadata.isVerified && (
                                        <span className="text-blue-500 text-[10px]">✓</span>
                                    )}
                                </div>
                                <div className="text-xs text-brand-gray">{asset.code}</div>
                            </div>
                        </div>

                        <div className="text-right">
                            <div className="font-medium text-brand-black">
                                {parseFloat(asset.balance).toLocaleString()} {asset.code}
                            </div>
                            <div className="text-xs text-brand-gray">
                                {/* Simplified currency formatting */}
                                {currency === 'USD' ? '$' : currency}
                                {asset.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
