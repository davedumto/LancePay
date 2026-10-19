import { NextResponse, type NextRequest } from "next/server";
import { verifyApiKey } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { RouteRateLimiter } from "@/lib/rate-limit";
import { getPersistedQuery } from "@/lib/persisted-queries";

const FIELD_SCOPE_MAP: Record<string, string> = {
  user: "read:user",
  profile: "read:user",
  invoices: "read:invoices",
  invoice: "read:invoices",
  transactions: "read:transactions",
  transaction: "read:transactions",
  wallet: "read:wallet",
  contacts: "read:contacts",
  contact: "read:contacts",
  admin: "admin:read",
};

const LIST_FIELDS = new Set(["invoices", "transactions", "contacts"]);

export interface QueryAnalysis {
  depth: number;
  complexity: number;
  requestedFields: string[];
}

/**
 * Parses query text to extract maximum depth, complexity, and top/nested field names.
 */
export function analyzeQuery(queryText: string): QueryAnalysis {
  // Strip comments and strings to avoid false token parsing
  const clean = queryText
    .replace(/#[^\r\n]*/g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');

  let maxDepth = 0;
  let currentDepth = 0;
  let complexity = 0;
  const requestedFields: string[] = [];

  // Tokenize braces and words
  const tokens = clean.match(/[{}]|[a-zA-Z_][a-zA-Z0-9_]*/g) || [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "{") {
      currentDepth++;
      if (currentDepth > maxDepth) {
        maxDepth = currentDepth;
      }
    } else if (token === "}") {
      currentDepth = Math.max(0, currentDepth - 1);
    } else {
      // Ignore GraphQL keywords
      if (
        ["query", "mutation", "subscription", "fragment", "on"].includes(token)
      ) {
        continue;
      }
      // If preceding token was '{' or followed by '{', it's a field
      const prev = tokens[i - 1];
      const next = tokens[i + 1];

      if (prev === "{" || next === "{" || currentDepth > 0) {
        if (!requestedFields.includes(token)) {
          requestedFields.push(token);
        }
        // Base complexity = 1; list/relational fields add 5
        complexity += LIST_FIELDS.has(token) ? 5 : 1;
      }
    }
  }

  // If query had an outer "query { ... }", subtract 1 from depth so root fields start at depth 1
  const effectiveDepth = maxDepth > 1 ? maxDepth - 1 : maxDepth;

  return {
    depth: effectiveDepth,
    complexity: Math.max(1, complexity),
    requestedFields,
  };
}

const limiter = new RouteRateLimiter({
  id: "graphql-gateway",
  maxRequests: 60,
  windowMs: 60_000,
});

export async function POST(request: NextRequest) {
  try {
    const rawApiKey =
      request.headers.get("x-api-key") ||
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

    if (!rawApiKey) {
      return NextResponse.json(
        { errors: [{ message: "Unauthorized: API key required" }] },
        { status: 401 },
      );
    }

    const auth = await verifyApiKey(rawApiKey);
    if (!auth) {
      return NextResponse.json(
        { errors: [{ message: "Unauthorized: Invalid API key" }] },
        { status: 401 },
      );
    }

    const { apiKey, userId } = auth;

    // 1. API key rate limit enforcement
    const rateCheck = limiter.check(apiKey.id);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { errors: [{ message: "Rate limit exceeded for API key" }] },
        { status: 429, headers: { "Retry-After": "60" } },
      );
    }

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json(
        { errors: [{ message: "Invalid JSON request body" }] },
        { status: 400 },
      );
    }

    // Support direct query or persisted query lookup by hash
    let queryText = body.query;
    const persistedHash =
      body.extensions?.persistedQuery?.sha256Hash || body.persistedQueryHash;

    if (!queryText && persistedHash) {
      const persisted = getPersistedQuery(apiKey.id, persistedHash);
      if (!persisted) {
        return NextResponse.json(
          { errors: [{ message: "PersistedQueryNotFound" }] },
          { status: 404 },
        );
      }
      queryText = persisted.query;
    }

    if (!queryText || typeof queryText !== "string" || !queryText.trim()) {
      return NextResponse.json(
        { errors: [{ message: "GraphQL query is required" }] },
        { status: 400 },
      );
    }

    // 2. Query Depth and Complexity Analysis
    const analysis = analyzeQuery(queryText);
    const maxDepth = (apiKey as any).maxDepth ?? 5;
    const maxComplexity = (apiKey as any).maxComplexity ?? 100;

    if (analysis.depth > maxDepth) {
      return NextResponse.json(
        {
          errors: [
            {
              message: `Query depth of ${analysis.depth} exceeds maximum allowed depth of ${maxDepth}`,
              depth: analysis.depth,
              maxDepth,
            },
          ],
        },
        { status: 400 },
      );
    }

    if (analysis.complexity > maxComplexity) {
      return NextResponse.json(
        {
          errors: [
            {
              message: `Query complexity of ${analysis.complexity} exceeds maximum allowed complexity of ${maxComplexity}`,
              complexity: analysis.complexity,
              maxComplexity,
            },
          ],
        },
        { status: 400 },
      );
    }

    // 3. Field-level Scope Enforcement
    // Caller scopes: explicit on apiKey or header or default allowed scopes
    const rawHeaderScopes = request.headers.get("x-api-scopes");
    const callerScopes: string[] = (apiKey as any).scopes ??
      (rawHeaderScopes
        ? rawHeaderScopes.split(",").map((s) => s.trim())
        : null) ?? [
        "read:user",
        "read:invoices",
        "read:transactions",
        "read:wallet",
        "read:contacts",
      ];

    const scopeErrors: Array<{
      message: string;
      field: string;
      requiredScope: string;
    }> = [];
    for (const field of analysis.requestedFields) {
      const requiredScope = FIELD_SCOPE_MAP[field];
      if (requiredScope && !callerScopes.includes(requiredScope)) {
        scopeErrors.push({
          message: `Forbidden: Missing required scope '${requiredScope}' for field '${field}'`,
          field,
          requiredScope,
        });
      }
    }

    if (scopeErrors.length > 0) {
      return NextResponse.json({ errors: scopeErrors }, { status: 403 });
    }

    // 4. Tenant-isolated resolver layer (userId is always scoped to authenticated caller)
    const data: Record<string, unknown> = {};

    if (
      analysis.requestedFields.includes("user") ||
      analysis.requestedFields.includes("profile")
    ) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          homeCurrency: true,
          createdAt: true,
        },
      });
      data.user = user;
    }

    if (
      analysis.requestedFields.includes("invoices") ||
      analysis.requestedFields.includes("invoice")
    ) {
      const invoices = await prisma.invoice.findMany({
        where: { userId },
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          amount: true,
          currency: true,
          createdAt: true,
        },
        take: 50,
      });
      data.invoices = invoices;
    }

    if (
      analysis.requestedFields.includes("transactions") ||
      analysis.requestedFields.includes("transaction")
    ) {
      const transactions = await prisma.transaction.findMany({
        where: { userId },
        select: {
          id: true,
          type: true,
          amount: true,
          currency: true,
          status: true,
          createdAt: true,
        },
        take: 50,
      });
      data.transactions = transactions;
    }

    if (analysis.requestedFields.includes("wallet")) {
      const wallet = await prisma.wallet.findUnique({
        where: { userId },
      });
      data.wallet = wallet;
    }

    if (
      analysis.requestedFields.includes("contacts") ||
      analysis.requestedFields.includes("contact")
    ) {
      const contacts = await prisma.contact.findMany({
        where: { userId },
      });
      data.contacts = contacts;
    }

    return NextResponse.json({ data }, { status: 200 });
  } catch (_error) {
    return NextResponse.json(
      { errors: [{ message: "Internal Server Error" }] },
      { status: 500 },
    );
  }
}
