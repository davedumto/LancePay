#!/bin/bash

# Verification script for Multi-Asset Dashboard Support

echo "Starting verification..."

# Check for new files
files=(
  "lib/stellar.ts"
  "lib/assets.ts"
  "lib/pricing.ts"
  "components/dashboard/asset-list.tsx"
  "components/dashboard/trustline-manager.tsx"
  "app/api/user/trustlines/route.ts"
)

for file in "${files[@]}"; do
  if [ -f "$file" ]; then
    echo "✅ Found $file"
  else
    echo "❌ Missing $file"
    exit 1
  fi
done

# Basic content checks
if grep -q "getAccountBalance" "lib/stellar.ts"; then
  echo "✅ lib/stellar.ts contains getAccountBalance"
else
  echo "❌ lib/stellar.ts missing getAccountBalance"
fi

if grep -q "resolveAssetMetadata" "lib/assets.ts"; then
  echo "✅ lib/assets.ts contains resolveAssetMetadata"
else
  echo "❌ lib/assets.ts missing resolveAssetMetadata"
fi

if grep -q "COINGECKO_API_URL" "lib/pricing.ts"; then
  echo "✅ lib/pricing.ts uses CoinGecko API"
else
  echo "❌ lib/pricing.ts missing CoinGecko API integration"
fi

if grep -q "Popular Assets" "components/dashboard/trustline-manager.tsx"; then
  echo "✅ TrustlineManager contains curated assets"
else
  echo "❌ TrustlineManager missing curated assets section"
fi

if grep -q "name=\"currency\"" "components/invoices/invoice-form.tsx"; then
  echo "✅ InvoiceForm contains currency selection"
else
  echo "❌ InvoiceForm missing currency selection"
fi

echo "Verification complete. All file checks passed."
echo "Please run 'npm run dev' and manually verify the dashboard in your browser."
