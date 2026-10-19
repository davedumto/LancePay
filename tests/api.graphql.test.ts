import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const verifyApiKey = vi.fn();
const userFindUnique = vi.fn();
const invoiceFindMany = vi.fn();
const transactionFindMany = vi.fn();
const walletFindUnique = vi.fn();
const contactFindMany = vi.fn();

vi.mock("@/lib/auth", () => ({
  verifyApiKey: (...args: any[]) => verifyApiKey(...args),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: (...args: any[]) => userFindUnique(...args) },
    invoice: { findMany: (...args: any[]) => invoiceFindMany(...args) },
    transaction: { findMany: (...args: any[]) => transactionFindMany(...args) },
    wallet: { findUnique: (...args: any[]) => walletFindUnique(...args) },
    contact: { findMany: (...args: any[]) => contactFindMany(...args) },
  },
}));

const URL = "http://localhost/api/graphql";

function postReq(
  body: object,
  apiKey: string | null = "lancepay_key_valid",
  extraHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...extraHeaders,
  };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }
  return new NextRequest(URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/graphql (#1564)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when API key is missing or invalid", async () => {
    verifyApiKey.mockResolvedValue(null);
    const { POST } = await import("@/app/api/graphql/route");
    const res = await POST(postReq({ query: "{ user { id } }" }, null));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.errors[0].message).toMatch(/unauthorized/i);
  });

  it("enforces maximum query depth limit and rejects overly nested queries", async () => {
    verifyApiKey.mockResolvedValue({
      userId: "user_1",
      apiKey: { id: "key_1", maxDepth: 2, maxComplexity: 100 },
    });

    const { POST } = await import("@/app/api/graphql/route");
    // Depth is 4, which exceeds maxDepth of 2
    const deepQuery = `
      query {
        user {
          invoices {
            transactions {
              wallet {
                id
              }
            }
          }
        }
      }
    `;
    const res = await POST(postReq({ query: deepQuery }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors[0].message).toMatch(/depth/i);
    expect(body.errors[0].maxDepth).toBe(2);
  });

  it("enforces maximum query complexity limit", async () => {
    verifyApiKey.mockResolvedValue({
      userId: "user_1",
      apiKey: { id: "key_1", maxDepth: 10, maxComplexity: 5 },
    });

    const { POST } = await import("@/app/api/graphql/route");
    // Multiple list fields exceed complexity ceiling of 5
    const complexQuery = `
      query {
        invoices { id amount status currency createdAt }
        transactions { id amount status type createdAt }
      }
    `;
    const res = await POST(postReq({ query: complexQuery }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors[0].message).toMatch(/complexity/i);
  });

  it("rejects queries that reference fields the caller does not hold a scope for", async () => {
    verifyApiKey.mockResolvedValue({
      userId: "user_1",
      apiKey: {
        id: "key_1",
        scopes: ["read:user"], // Only user scope, no read:invoices scope!
      },
    });

    const { POST } = await import("@/app/api/graphql/route");
    const query = `
      query {
        user { id name }
        invoices { id amount }
      }
    `;
    const res = await POST(postReq({ query }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].field).toBe("invoices");
    expect(body.errors[0].requiredScope).toBe("read:invoices");
  });

  it("enforces tenant isolation and never queries another user data", async () => {
    verifyApiKey.mockResolvedValue({
      userId: "user_123",
      apiKey: {
        id: "key_1",
        scopes: ["read:user", "read:invoices"],
      },
    });
    userFindUnique.mockResolvedValue({ id: "user_123", name: "Alice" });
    invoiceFindMany.mockResolvedValue([
      { id: "inv_1", amount: 100, userId: "user_123" },
    ]);

    const { POST } = await import("@/app/api/graphql/route");
    const query = `
      query {
        user { id name }
        invoices { id amount }
      }
    `;
    const res = await POST(postReq({ query }));
    expect(res.status).toBe(200);

    // Verify tenant isolation: queries must have where.userId = user_123
    expect(userFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user_123" },
      }),
    );
    expect(invoiceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user_123" },
      }),
    );

    const body = await res.json();
    expect(body.data.user.name).toBe("Alice");
    expect(body.data.invoices).toHaveLength(1);
  });
});
