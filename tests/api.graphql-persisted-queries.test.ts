import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  computePersistedQueryHash,
  registerPersistedQuery,
  resetPersistedQueryStore,
} from "@/lib/persisted-queries";

const verifyApiKey = vi.fn();
const sandboxSessionFindFirst = vi.fn();

vi.mock("@/lib/auth", () => ({
  verifyApiKey: (...args: any[]) => verifyApiKey(...args),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    sandboxSession: {
      findFirst: (...args: any[]) => sandboxSessionFindFirst(...args),
    },
  },
}));

const URL_BASE = "http://localhost/api/graphql/persisted-queries";

function makeRequest(
  hash: string,
  apiKeyHeader: string | null = "lancepay_live_key_123",
  extraHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = { ...extraHeaders };
  if (apiKeyHeader) {
    headers["x-api-key"] = apiKeyHeader;
  }
  return new NextRequest(`${URL_BASE}/${hash}`, {
    method: "GET",
    headers,
  });
}

describe("GET /api/graphql/persisted-queries/[hash] (#1567)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPersistedQueryStore();
  });

  it("returns 401 when API key is missing or invalid", async () => {
    verifyApiKey.mockResolvedValue(null);
    const { GET } =
      await import("@/app/api/graphql/persisted-queries/[hash]/route");
    const res = await GET(makeRequest("hash123", null), {
      params: Promise.resolve({ hash: "hash123" }),
    });

    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/unauthorized/i);
  });

  it("returns 403 when parent developer app is disabled", async () => {
    verifyApiKey.mockResolvedValue({
      userId: "user_1",
      apiKey: { id: "app_1", isActive: false, name: "Prod App" },
    });

    const { GET } =
      await import("@/app/api/graphql/persisted-queries/[hash]/route");
    const res = await GET(makeRequest("hash123"), {
      params: Promise.resolve({ hash: "hash123" }),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/disabled/i);
  });

  it("rejects lookup when app is in sandbox mode mismatching live gateway", async () => {
    verifyApiKey.mockResolvedValue({
      userId: "user_1",
      apiKey: { id: "app_sandbox", isActive: true, name: "My Sandbox App" },
    });
    sandboxSessionFindFirst.mockResolvedValue({
      id: "sess_1",
      status: "active",
    });

    const { GET } =
      await import("@/app/api/graphql/persisted-queries/[hash]/route");
    const res = await GET(
      makeRequest("hash123", "lancepay_key", { "x-gateway-mode": "live" }),
      { params: Promise.resolve({ hash: "hash123" }) },
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/mode mismatch/i);
  });

  it("rejects lookup when app is in live mode mismatching sandbox gateway", async () => {
    verifyApiKey.mockResolvedValue({
      userId: "user_1",
      apiKey: { id: "app_live", isActive: true, name: "My Live App" },
    });
    sandboxSessionFindFirst.mockResolvedValue(null);

    const { GET } =
      await import("@/app/api/graphql/persisted-queries/[hash]/route");
    const res = await GET(
      makeRequest("hash123", "lancepay_key", { "x-gateway-mode": "sandbox" }),
      { params: Promise.resolve({ hash: "hash123" }) },
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/mode mismatch/i);
  });

  it("returns 404 indistinguishable between not registered and not authorized", async () => {
    verifyApiKey.mockResolvedValue({
      userId: "user_1",
      apiKey: { id: "app_1", isActive: true, name: "Prod App" },
    });
    sandboxSessionFindFirst.mockResolvedValue(null);

    // Register query under a DIFFERENT app (app_2)
    const secretQuery = "query { secretData }";
    const secretHash = computePersistedQueryHash(secretQuery);
    registerPersistedQuery("app_2", secretHash, secretQuery);

    const { GET } =
      await import("@/app/api/graphql/persisted-queries/[hash]/route");

    // Querying for app_2's query with app_1 key:
    const unauthorizedRes = await GET(makeRequest(secretHash), {
      params: Promise.resolve({ hash: secretHash }),
    });
    expect(unauthorizedRes.status).toBe(404);
    expect(await unauthorizedRes.json()).toEqual({
      error: "Persisted query not found",
    });

    // Querying for a completely unknown query:
    const notRegisteredRes = await GET(makeRequest("hash_unknown"), {
      params: Promise.resolve({ hash: "hash_unknown" }),
    });
    expect(notRegisteredRes.status).toBe(404);
    expect(await notRegisteredRes.json()).toEqual({
      error: "Persisted query not found",
    });
  });

  it("resolves the hash scoped to developer app and increments access count", async () => {
    verifyApiKey.mockResolvedValue({
      userId: "user_1",
      apiKey: { id: "app_1", isActive: true, name: "Prod App" },
    });
    sandboxSessionFindFirst.mockResolvedValue(null);

    const userQuery = "query GetUser { user { id name } }";
    const userHash = computePersistedQueryHash(userQuery);
    registerPersistedQuery("app_1", userHash, userQuery);

    const { GET } =
      await import("@/app/api/graphql/persisted-queries/[hash]/route");

    // First request
    const res1 = await GET(makeRequest(userHash), {
      params: Promise.resolve({ hash: userHash }),
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.hash).toBe(userHash);
    expect(body1.query).toBe(userQuery);
    expect(body1.accessCount).toBe(1);
    expect(body1.appId).toBe("app_1");
    expect(body1.lastAccessedAt).toBeTruthy();

    // Second request
    const res2 = await GET(makeRequest(userHash), {
      params: Promise.resolve({ hash: userHash }),
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.accessCount).toBe(2);
  });
});
