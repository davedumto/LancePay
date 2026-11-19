import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const verifyAuthToken = vi.fn();
const userFindUnique = vi.fn();
const invoiceFindFirst = vi.fn();
const paymentReminderCreate = vi.fn();
const paymentReminderFindFirst = vi.fn();
const auditEventCreate = vi.fn();
const sendInvoiceToClient = vi.fn();

vi.mock("@/lib/auth", () => ({ verifyAuthToken }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: { findFirst: invoiceFindFirst },
    paymentReminder: {
      create: paymentReminderCreate,
      findFirst: paymentReminderFindFirst,
    },
    auditEvent: { create: auditEventCreate },
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/email", () => ({ sendInvoiceToClient }));

const URL = "http://localhost/api/routes-b/invoices/inv-1/reminders/send";

function req(token: string | null = "tok") {
  const h = new Headers();
  if (token) h.set("authorization", `Bearer ${token}`);
  return new NextRequest(URL, { method: "POST", headers: h });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const SAMPLE_INVOICE = {
  id: "inv-1",
  userId: "user-1",
  invoiceNumber: "INV-001",
  clientEmail: "client@example.com",
  clientName: "Client Co",
  amount: "100.00",
  currency: "USD",
  status: "pending",
  paymentLink: "https://pay.example.com/inv-1",
  dueDate: null,
};

describe("POST /api/routes-b/invoices/[id]/reminders/send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFindUnique.mockResolvedValue({
      id: "user-1",
      name: "Freelancer",
      email: "f@example.com",
    });
    invoiceFindFirst.mockResolvedValue(SAMPLE_INVOICE);
    sendInvoiceToClient.mockResolvedValue({ success: true });
    paymentReminderCreate.mockResolvedValue({
      id: "rem-1",
      invoiceId: "inv-1",
      reminderType: "manual",
    });
    auditEventCreate.mockResolvedValue({ id: "evt-1" });
    paymentReminderFindFirst.mockResolvedValue(null);
  });

  it("returns 401 when unauthenticated", async () => {
    verifyAuthToken.mockResolvedValue(null);
    const { POST } =
      await import("@/app/api/routes-b/invoices/[id]/reminders/send/route");
    const res = await POST(req(), ctx("inv-1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when invoice not found or not owned", async () => {
    verifyAuthToken.mockResolvedValue({ userId: "u1" });
    invoiceFindFirst.mockResolvedValue(null);
    const { POST } =
      await import("@/app/api/routes-b/invoices/[id]/reminders/send/route");
    const res = await POST(req(), ctx("inv-1"));
    expect(res.status).toBe(404);
  });

  it("returns 422 when the invoice is already paid", async () => {
    verifyAuthToken.mockResolvedValue({ userId: "u1" });
    invoiceFindFirst.mockResolvedValue({ ...SAMPLE_INVOICE, status: "paid" });
    const { POST } =
      await import("@/app/api/routes-b/invoices/[id]/reminders/send/route");
    const res = await POST(req(), ctx("inv-1"));
    expect(res.status).toBe(422);
  });

  it("returns 422 when the invoice is void", async () => {
    verifyAuthToken.mockResolvedValue({ userId: "u1" });
    invoiceFindFirst.mockResolvedValue({ ...SAMPLE_INVOICE, status: "void" });
    const { POST } =
      await import("@/app/api/routes-b/invoices/[id]/reminders/send/route");
    const res = await POST(req(), ctx("inv-1"));
    expect(res.status).toBe(422);
  });

  it("returns 429 when a reminder was recently sent (within cooldown)", async () => {
    verifyAuthToken.mockResolvedValue({ userId: "u1" });
    const recentReminder = {
      id: "rem-old",
      invoiceId: "inv-1",
      createdAt: new Date(Date.now() - 5 * 60 * 1000), // 5 minutes ago
    };
    paymentReminderFindFirst.mockResolvedValue(recentReminder);
    const { POST } =
      await import("@/app/api/routes-b/invoices/[id]/reminders/send/route");
    const res = await POST(req(), ctx("inv-1"));
    expect(res.status).toBe(429);
  });

  it("allows reminder send when no recent reminder exists", async () => {
    verifyAuthToken.mockResolvedValue({ userId: "u1" });
    paymentReminderFindFirst.mockResolvedValue(null);
    const { POST } =
      await import("@/app/api/routes-b/invoices/[id]/reminders/send/route");
    const res = await POST(req(), ctx("inv-1"));
    expect(res.status).toBe(200);
  });

  it("allows reminder send when recent reminder is outside cooldown", async () => {
    verifyAuthToken.mockResolvedValue({ userId: "u1" });
    const oldReminder = {
      id: "rem-old",
      invoiceId: "inv-1",
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
    };
    paymentReminderFindFirst.mockResolvedValue(oldReminder);
    const { POST } =
      await import("@/app/api/routes-b/invoices/[id]/reminders/send/route");
    const res = await POST(req(), ctx("inv-1"));
    expect(res.status).toBe(200);
  });

  it("sends the reminder email and records a PaymentReminder + AuditEvent", async () => {
    verifyAuthToken.mockResolvedValue({ userId: "u1" });
    const { POST } =
      await import("@/app/api/routes-b/invoices/[id]/reminders/send/route");
    const res = await POST(req(), ctx("inv-1"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sent).toBe(true);
    expect(json.reminderId).toBe("rem-1");

    expect(sendInvoiceToClient).toHaveBeenCalledWith(
      expect.objectContaining({
        clientEmail: "client@example.com",
        invoiceNumber: "INV-001",
      }),
    );
    expect(paymentReminderCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          invoiceId: "inv-1",
          reminderType: "manual",
        }),
      }),
    );
    expect(auditEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          invoiceId: "inv-1",
          eventType: "reminder_sent",
        }),
      }),
    );
  });

  it("still returns 200 with sent:false when the email send fails", async () => {
    verifyAuthToken.mockResolvedValue({ userId: "u1" });
    sendInvoiceToClient.mockRejectedValue(new Error("SMTP down"));
    const { POST } =
      await import("@/app/api/routes-b/invoices/[id]/reminders/send/route");
    const res = await POST(req(), ctx("inv-1"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sent).toBe(false);
    expect(paymentReminderCreate).toHaveBeenCalled();
  });
});
