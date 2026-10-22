import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST, GET } from "./route";
import { GET as checkWatchlist } from "./check/route";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    securityWatchlist: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/app/api/_lib/compliance-auth", () => ({
  requireComplianceActor: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { requireComplianceActor } from "@/app/api/_lib/compliance-auth";

function makePostRequest(body: object): NextRequest {
  return new NextRequest("http://localhost/api/security-watchlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeCheckRequest(query: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/security-watchlist/check${query}`,
    {
      method: "GET",
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireComplianceActor).mockResolvedValue({
    actor: { id: "compliance-1", role: "compliance", email: "c@lancepay.com" },
  } as any);
});

describe("POST /api/security-watchlist & check matching (issue #1651)", () => {
  it("normalizes mixed-case email to lowercase on create", async () => {
    vi.mocked(prisma.securityWatchlist.create).mockImplementation(
      async ({ data }: any) => ({
        id: "entry-1",
        ...data,
        createdAt: new Date(),
      }),
    );

    const req = makePostRequest({
      type: "email",
      value: "  Fraudster@Example.COM  ",
      reason: "Sanctioned entity",
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.entry.value).toBe("fraudster@example.com");

    expect(prisma.securityWatchlist.create).toHaveBeenCalledWith({
      data: {
        type: "email",
        value: "fraudster@example.com",
        reason: "Sanctioned entity",
      },
    });
  });

  it("normalizes mixed-case 0x EVM wallet to lowercase on create", async () => {
    vi.mocked(prisma.securityWatchlist.create).mockImplementation(
      async ({ data }: any) => ({
        id: "entry-2",
        ...data,
        createdAt: new Date(),
      }),
    );

    const req = makePostRequest({
      type: "wallet",
      value: "0xAbCdEf1234567890",
      reason: "Exploit address",
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.entry.value).toBe("0xabcdef1234567890");

    expect(prisma.securityWatchlist.create).toHaveBeenCalledWith({
      data: {
        type: "wallet",
        value: "0xabcdef1234567890",
        reason: "Exploit address",
      },
    });
  });

  it("asserts a watchlist entry added in mixed case matches a differently-cased check query", async () => {
    let savedValue = "";
    vi.mocked(prisma.securityWatchlist.create).mockImplementation(
      async ({ data }: any) => {
        savedValue = data.value;
        return { id: "entry-3", ...data, createdAt: new Date() };
      },
    );

    // 1. Compliance creates entry with mixed case
    const createReq = makePostRequest({
      type: "email",
      value: "Fraudster@Example.com",
      reason: "OFAC Sanctioned",
    });
    const createRes = await POST(createReq);
    expect(createRes.status).toBe(201);
    expect(savedValue).toBe("fraudster@example.com");

    // 2. Client queries check endpoint with lowercase
    vi.mocked(prisma.securityWatchlist.findFirst).mockImplementation(
      async ({ where }: any) => {
        if (where.value === savedValue) {
          return {
            id: "entry-3",
            type: "email",
            value: savedValue,
            reason: "OFAC Sanctioned",
          } as any;
        }
        return null;
      },
    );

    const checkReq = makeCheckRequest("?value=fraudster@example.com");
    const checkRes = await checkWatchlist(checkReq);
    expect(checkRes.status).toBe(200);
    const checkJson = await checkRes.json();
    expect(checkJson.match).toBe(true);
    expect(checkJson.type).toBe("email");

    // 3. Client queries check endpoint with UPPERCASE
    const upperCheckReq = makeCheckRequest("?value=FRAUDSTER@EXAMPLE.COM");
    const upperCheckRes = await checkWatchlist(upperCheckReq);
    expect(upperCheckRes.status).toBe(200);
    const upperJson = await upperCheckRes.json();
    expect(upperJson.match).toBe(true);
    expect(upperJson.type).toBe("email");
  });
});
