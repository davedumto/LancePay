import { NextResponse, type NextRequest } from "next/server";
import { verifyApiKey } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getPersistedQuery } from "@/lib/persisted-queries";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ hash: string }> | { hash: string } },
) {
  try {
    const rawApiKey =
      request.headers.get("x-api-key") ||
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

    if (!rawApiKey) {
      return NextResponse.json(
        { error: "Unauthorized: API key required" },
        { status: 401 },
      );
    }

    const auth = await verifyApiKey(rawApiKey);
    if (!auth) {
      return NextResponse.json(
        { error: "Unauthorized: Invalid API key" },
        { status: 401 },
      );
    }

    const { apiKey } = auth;

    // Reject lookup when developer app is disabled
    if (!apiKey.isActive) {
      return NextResponse.json(
        { error: "Developer app is disabled" },
        { status: 403 },
      );
    }

    // Check sandbox mode vs gateway mode mismatch
    const gatewayMode = request.headers.get("x-gateway-mode") || "live";
    const activeSandboxSession = await prisma.sandboxSession.findFirst({
      where: {
        apiKeyId: apiKey.id,
        status: "active",
      },
    });
    const isAppSandbox = Boolean(
      activeSandboxSession ||
      apiKey.name?.toLowerCase().includes("sandbox") ||
      request.headers.get("x-sandbox-mode") === "true",
    );

    if (gatewayMode === "live" && isAppSandbox) {
      return NextResponse.json(
        {
          error:
            "Mode mismatch: Sandbox developer app cannot query live gateway",
        },
        { status: 403 },
      );
    }

    if (gatewayMode === "sandbox" && !isAppSandbox) {
      return NextResponse.json(
        {
          error:
            "Mode mismatch: Live developer app cannot query sandbox gateway",
        },
        { status: 403 },
      );
    }

    const { hash } = await Promise.resolve(context.params);
    if (!hash) {
      return NextResponse.json(
        { error: "Query hash is required" },
        { status: 400 },
      );
    }

    // Resolve the hash scoped to caller's developer app
    const record = getPersistedQuery(apiKey.id, hash);

    // Indistinguishable 404 between not registered and not authorized
    if (!record || record.appId !== apiKey.id) {
      return NextResponse.json(
        { error: "Persisted query not found" },
        { status: 404 },
      );
    }

    // Record lightweight access count
    record.accessCount += 1;
    record.lastAccessedAt = new Date();

    return NextResponse.json(
      {
        hash: record.hash,
        query: record.query,
        accessCount: record.accessCount,
        appId: apiKey.id,
      },
      { status: 200 },
    );
  } catch (_error) {
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
