import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { GET } from "../notifications/digest/route";

//  Test Helpers

const TEST_USER_PRIVY_ID = "test-user-digest-001";
const TEST_USER_EMAIL = "test-digest@lancepay.dev";

let testUserId: string;

async function createTestUser(timezone = "UTC") {
  const user = await prisma.user.upsert({
    where: { privyId: TEST_USER_PRIVY_ID },
    update: {},
    create: {
      privyId: TEST_USER_PRIVY_ID,
      email: TEST_USER_EMAIL,
      name: "Test User Digest",
      timezone,
    },
  });
  testUserId = user.id;
  return user;
}

async function seedNotifications(
  userId: string,
  date: Date,
  types: string[]
) {
  const notifications = types.map((type, i) => ({
    userId,
    type,
    title: `${type} notification ${i}`,
    message: `Message for ${type}`,
    isRead: i % 3 === 0, // every 3rd is read
    createdAt: new Date(date.getTime() + i * 1000 * 60), // spaced 1 min apart
  }));

  await prisma.notification.createMany({ data: notifications });
  return notifications.length;
}

function mockRequest(date?: string, timezone?: string): Request {
  const url = new URL("http://localhost:3000/api/routes-b/notifications/digest");
  if (date) url.searchParams.set("date", date);

  const headers: Record<string, string> = {
    authorization: "Bearer test-token",
  };
  if (timezone) headers["x-user-timezone"] = timezone;

  return new Request(url.toString(), { headers });
}

// Mock Auth

vi.mock("@/lib/auth", () => ({
  verifyAuthToken: vi.fn(async (token: string) => {
    if (token === "test-token") {
      return { userId: TEST_USER_PRIVY_ID };
    }
    return null;
  }),
}));

// Test Suite 

describe("GET /notifications/digest", () => {
  beforeAll(async () => {
    await createTestUser();
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: testUserId } });
    await prisma.user.deleteMany({ where: { privyId: TEST_USER_PRIVY_ID } });
  });

  beforeEach(async () => {
    await prisma.notification.deleteMany({ where: { userId: testUserId } });
  });

  //  Empty Day

  it("returns empty digest for day with no notifications", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const req = mockRequest(today);
    const res = await GET(req);

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.period.date).toBe(today);
    expect(body.totalsByType).toEqual({});
    expect(body.top).toEqual([]);
    expect(body.summary).toEqual({ total: 0, unread: 0 });
  });

  // Multi-Type Day 

  it("groups totals by type correctly", async () => {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    await seedNotifications(testUserId, today, [
      "invoice_paid",
      "invoice_paid",
      "invoice_paid",
      "withdrawal_complete",
      "withdrawal_complete",
      "system",
      "escrow_released",
    ]);

    const req = mockRequest(todayStr);
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.totalsByType).toEqual({
      invoice_paid: 3,
      withdrawal_complete: 2,
      system: 1,
      escrow_released: 1,
    });
    expect(body.summary.total).toBe(7);
    expect(body.summary.unread).toBe(5); // 2 are read (indices 0, 3)
  });

  it("returns top 10 most recent notifications", async () => {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    // Create 15 notifications
    const types = Array(15).fill("invoice_paid");
    await seedNotifications(testUserId, today, types);

    const req = mockRequest(todayStr);
    const res = await GET(req);
    const body = await res.json();

    expect(body.top).toHaveLength(10);
    // Should be ordered newest first
    const timestamps = body.top.map((n: any) => new Date(n.createdAt).getTime());
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
    }
  });

  //  Timezone Handling

  it("respects user timezone from DB", async () => {
    // Update user to non-UTC timezone
    await prisma.user.update({
      where: { id: testUserId },
      data: { timezone: "America/New_York" },
    });

    const todayStr = new Date().toISOString().slice(0, 10);
    const req = mockRequest(todayStr);
    const res = await GET(req);
    const body = await res.json();

    expect(body.period.timezone).toBe("America/New_York");

    // Reset
    await prisma.user.update({
      where: { id: testUserId },
      data: { timezone: "UTC" },
    });
  });

  it("falls back to x-user-timezone header when DB timezone is null", async () => {
    await prisma.user.update({
      where: { id: testUserId },
      data: { timezone: null },
    });

    const todayStr = new Date().toISOString().slice(0, 10);
    const req = mockRequest(todayStr, "Asia/Tokyo");
    const res = await GET(req);
    const body = await res.json();

    expect(body.period.timezone).toBe("Asia/Tokyo");

    // Reset
    await prisma.user.update({
      where: { id: testUserId },
      data: { timezone: "UTC" },
    });
  });

  it("defaults to UTC when no timezone provided", async () => {
    await prisma.user.update({
      where: { id: testUserId },
      data: { timezone: null },
    });

    const todayStr = new Date().toISOString().slice(0, 10);
    const req = new Request(
      `http://localhost:3000/api/routes-b/notifications/digest?date=${todayStr}`,
      { headers: { authorization: "Bearer test-token" } }
    );
    const res = await GET(req);
    const body = await res.json();

    expect(body.period.timezone).toBe("UTC");

    // Reset
    await prisma.user.update({
      where: { id: testUserId },
      data: { timezone: "UTC" },
    });
  });

  //  Future Date Rejected 

  it("rejects future dates with 400", async () => {
    const future = new Date();
    future.setDate(future.getDate() + 7);
    const futureStr = future.toISOString().slice(0, 10);

    const req = mockRequest(futureStr);
    const res = await GET(req);

    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("INVALID_DATE");
    expect(body.error).toContain("Future dates are not allowed");
  });

  it("defaults to today when no date param provided", async () => {
    await seedNotifications(testUserId, new Date(), ["invoice_paid"]);

    const req = new Request(
      "http://localhost:3000/api/routes-b/notifications/digest",
      { headers: { authorization: "Bearer test-token" } }
    );
    const res = await GET(req);
    const body = await res.json();

    const todayStr = new Date().toISOString().slice(0, 10);
    expect(body.period.date).toBe(todayStr);
    expect(body.summary.total).toBeGreaterThan(0);
  });

  // Auth & Errors 

  it("returns 401 without auth token", async () => {
    const req = new Request(
      "http://localhost:3000/api/routes-b/notifications/digest"
    );
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid token", async () => {
    const req = new Request(
      "http://localhost:3000/api/routes-b/notifications/digest",
      { headers: { authorization: "Bearer bad-token" } }
    );
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  //  Constant-Time Response Shape 

  it("returns consistent shape regardless of data volume", async () => {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    // Empty
    const req1 = mockRequest(todayStr);
    const res1 = await GET(req1);
    const body1 = await res1.json();

    // With data
    await seedNotifications(testUserId, today, Array(50).fill("system"));
    const req2 = mockRequest(todayStr);
    const res2 = await GET(req2);
    const body2 = await res2.json();

    // Same keys
    expect(Object.keys(body1)).toEqual(Object.keys(body2));
    expect(Object.keys(body1.period)).toEqual(Object.keys(body2.period));
    expect(Array.isArray(body1.top)).toBe(true);
    expect(Array.isArray(body2.top)).toBe(true);
  });

  // Boundary Tests 

  it("correctly filters notifications at day boundaries", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    // Yesterday notification
    await seedNotifications(testUserId, yesterday, ["invoice_paid"]);

    // Today notification
    await seedNotifications(testUserId, new Date(), ["withdrawal_complete"]);

    const req = mockRequest(yesterdayStr);
    const res = await GET(req);
    const body = await res.json();

    expect(body.totalsByType).toEqual({ invoice_paid: 1 });
    expect(body.summary.total).toBe(1);
  });

  it("handles invalid date format gracefully", async () => {
    const req = mockRequest("not-a-date");
    const res = await GET(req);

    // Should either 400 or fallback to today
    expect([200, 400]).toContain(res.status);
  });
});