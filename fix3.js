const fs = require('fs');
const path = require('path');
const files = [
  'app/api/api-keys/[id]/rotate/route.ts',
  'app/api/ledger/multi-currency-trial-balance/route.ts',
  'app/api/routes-b/automations/[id]/route.ts',
  'app/api/routes-b/bank-accounts/[id]/route.ts',
  'app/api/routes-b/clients/[id]/contacts/[contactId]/route.ts',
  'app/api/routes-b/clients/[id]/feedback/route.ts',
  'app/api/routes-b/clients/[id]/rating/route.ts',
  'app/api/routes-b/comments/[id]/mentions/route.ts',
  'app/api/routes-b/contacts/[id]/route.ts',
  'app/api/routes-b/email-templates/[id]/preview/route.ts',
  'app/api/routes-b/email-templates/[id]/versions/[v]/activate/route.ts',
  'app/api/routes-b/email-templates/[id]/versions/route.ts',
  'app/api/routes-b/invoices/[id]/allocations/route.ts',
  'app/api/routes-b/invoices/[id]/payment-methods/route.ts',
  'app/api/routes-b/invoices/[id]/regenerate-pdf/route.ts',
  'app/api/routes-b/notes/[id]/pin/route.ts',
  'app/api/routes-b/quotes/[id]/route.ts',
  'app/api/routes-d/auth/tokens/[id]/ip-allowlist/route.ts',
  'app/api/webhook-deliveries/[id]/replay/route.ts'
];

for (const file of files) {
  const fullPath = path.resolve(__dirname, file);
  if (fs.existsSync(fullPath)) {
    let content = fs.readFileSync(fullPath, 'utf8');
    content = content.replace(/params\.([a-zA-Z0-9_]+)/g, '(await params).$1');
    content = content.replace(/\(await params\)\.get/g, 'params.get'); 
    fs.writeFileSync(fullPath, content);
    console.log('Fixed', file);
  } else {
    console.log('Not found', fullPath);
  }
}
