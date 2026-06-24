import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ verifyAuthToken: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    project: { findFirst: vi.fn() },
    invoice: { findMany: vi.fn() },
    timeEntry: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { verifyAuthToken } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { GET } from "../route";

const mockedVerify = vi.mocked(verifyAuthToken);
const userDelegate = prisma.user as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
};
const projectDelegate = prisma.project as unknown as {
  findFirst: ReturnType<typeof vi.fn>;
};
const invoiceDelegate = prisma.invoice as unknown as {
  findMany: ReturnType<typeof vi.fn>;
};
const timeEntryDelegate = prisma.timeEntry as unknown as {
  findMany: ReturnType<typeof vi.fn>;
};

const BASE_URL = "http://localhost/api/routes-b/projects/proj-1/profitability";

function makeGet(search?: string, authHeader: string | null = "Bearer token") {
  const url = search ? `${BASE_URL}?${search}` : BASE_URL;
  return new NextRequest(url, {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

function createParams(id: string = "proj-1") {
  return Promise.resolve({ id });
}

describe("GET /api/routes-b/projects/[id]/profitability", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 401 when unauthenticated", async () => {
    mockedVerify.mockResolvedValue(null as never);
    const res = await GET(makeGet(undefined, null), { params: createParams() });
    expect(res.status).toBe(401);
  });

  it("returns 404 when user not found", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue(null);
    const res = await GET(makeGet(), { params: createParams() });
    expect(res.status).toBe(404);
  });

  it("returns 400 when id is missing", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    const res = await GET(makeGet(), { params: createParams("") });
    expect(res.status).toBe(400);
  });

  it("returns 404 when project not found", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    projectDelegate.findFirst.mockResolvedValue(null);
    const res = await GET(makeGet(), { params: createParams() });
    expect(res.status).toBe(404);
  });

  it("returns profitability report with paid invoices and time entries", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    projectDelegate.findFirst.mockResolvedValue({
      id: "proj-1",
      title: "Website Redesign",
      status: "active",
    });
    invoiceDelegate.findMany.mockResolvedValue([
      {
        id: "inv-1",
        amount: 1000,
        currency: "USD",
        paidAt: new Date("2026-01-15T00:00:00Z"),
      },
      {
        id: "inv-2",
        amount: 1500,
        currency: "USD",
        paidAt: new Date("2026-01-20T00:00:00Z"),
      },
    ]);
    timeEntryDelegate.findMany.mockResolvedValue([
      {
        id: "te-1",
        hours: 10,
        rateUsdc: 50,
      },
      {
        id: "te-2",
        hours: 5,
        rateUsdc: 75,
      },
    ]);

    const res = await GET(makeGet(), { params: createParams() });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.projectId).toBe("proj-1");
    expect(body.projectTitle).toBe("Website Redesign");
    expect(body.projectStatus).toBe("active");
    expect(body.report.invoiceCount).toBe(2);
    expect(body.report.totalRevenue).toBe("2500.00");
    expect(body.report.avgInvoiceValue).toBe("1250.00");
    expect(body.report.currency).toBe("USD");
    expect(body.report.timeEntries.unbilledCount).toBe(2);
    expect(body.report.timeEntries.totalBillableHours).toBe("15.00");
    expect(body.report.timeEntries.potentialRevenue).toBe("875.00");
  });

  it("returns zero values when no invoices or time entries exist", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    projectDelegate.findFirst.mockResolvedValue({
      id: "proj-2",
      title: "New Project",
      status: "active",
    });
    invoiceDelegate.findMany.mockResolvedValue([]);
    timeEntryDelegate.findMany.mockResolvedValue([]);

    const res = await GET(makeGet(), { params: createParams("proj-2") });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.report.invoiceCount).toBe(0);
    expect(body.report.totalRevenue).toBe("0.00");
    expect(body.report.avgInvoiceValue).toBe("0.00");
    expect(body.report.currency).toBe("USD");
    expect(body.report.timeEntries.unbilledCount).toBe(0);
    expect(body.report.timeEntries.totalBillableHours).toBe("0.00");
    expect(body.report.timeEntries.potentialRevenue).toBe("0.00");
  });

  it("filters invoices by since date", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    projectDelegate.findFirst.mockResolvedValue({
      id: "proj-1",
      title: "Website Redesign",
      status: "active",
    });
    invoiceDelegate.findMany.mockResolvedValue([]);
    timeEntryDelegate.findMany.mockResolvedValue([]);

    const sinceDate = "2026-01-10T00:00:00Z";
    await GET(makeGet(`since=${encodeURIComponent(sinceDate)}`), {
      params: createParams(),
    });

    expect(invoiceDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          paidAt: expect.objectContaining({
            gte: expect.any(Date),
          }),
        }),
      }),
    );
  });

  it("filters invoices by until date", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    projectDelegate.findFirst.mockResolvedValue({
      id: "proj-1",
      title: "Website Redesign",
      status: "active",
    });
    invoiceDelegate.findMany.mockResolvedValue([]);
    timeEntryDelegate.findMany.mockResolvedValue([]);

    const untilDate = "2026-02-01T00:00:00Z";
    await GET(makeGet(`until=${encodeURIComponent(untilDate)}`), {
      params: createParams(),
    });

    expect(invoiceDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          paidAt: expect.objectContaining({
            lte: expect.any(Date),
          }),
        }),
      }),
    );
  });

  it("filters invoices by both since and until dates", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    projectDelegate.findFirst.mockResolvedValue({
      id: "proj-1",
      title: "Website Redesign",
      status: "active",
    });
    invoiceDelegate.findMany.mockResolvedValue([]);
    timeEntryDelegate.findMany.mockResolvedValue([]);

    const sinceDate = "2026-01-10T00:00:00Z";
    const untilDate = "2026-02-01T00:00:00Z";
    await GET(
      makeGet(
        `since=${encodeURIComponent(sinceDate)}&until=${encodeURIComponent(untilDate)}`,
      ),
      { params: createParams() },
    );

    expect(invoiceDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          paidAt: expect.objectContaining({
            gte: expect.any(Date),
            lte: expect.any(Date),
          }),
        }),
      }),
    );
  });

  it("ignores invalid date filters", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    projectDelegate.findFirst.mockResolvedValue({
      id: "proj-1",
      title: "Website Redesign",
      status: "active",
    });
    invoiceDelegate.findMany.mockResolvedValue([]);
    timeEntryDelegate.findMany.mockResolvedValue([]);

    await GET(makeGet(`since=invalid&until=also-invalid`), {
      params: createParams(),
    });

    expect(invoiceDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({
          paidAt: expect.anything(),
        }),
      }),
    );
  });

  it("handles decimal amounts correctly", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    projectDelegate.findFirst.mockResolvedValue({
      id: "proj-1",
      title: "Website Redesign",
      status: "active",
    });
    invoiceDelegate.findMany.mockResolvedValue([
      {
        id: "inv-1",
        amount: { toString: () => "123.456" },
        currency: "USD",
        paidAt: new Date(),
      },
    ]);
    timeEntryDelegate.findMany.mockResolvedValue([]);

    const res = await GET(makeGet(), { params: createParams() });
    const body = await res.json();

    expect(body.report.totalRevenue).toBe("123.46");
  });

  it("ensures project ownership is checked", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockResolvedValue({ id: "user-1" });
    projectDelegate.findFirst.mockResolvedValue(null);

    await GET(makeGet(), { params: createParams() });

    expect(projectDelegate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          id: "proj-1",
        }),
      }),
    );
  });

  it("returns 500 on database error", async () => {
    mockedVerify.mockResolvedValue({ userId: "privy_1" } as never);
    userDelegate.findUnique.mockRejectedValue(
      new Error("DB connection failed"),
    );

    const res = await GET(makeGet(), { params: createParams() });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to generate profitability report");
  });
});
