import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findFirst: vi.fn(),
    },
    contact: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
  mockVerifyAuthToken: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }));
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }));

import { GET, POST } from './route';

function makeRequest(method: 'GET' | 'POST', body?: unknown, search = '', authHeader = 'Bearer valid-token') {
  const headers: Record<string, string> = {};
  if (authHeader) headers.authorization = authHeader;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(`http://localhost/api/contacts${search}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('GET & POST /api/contacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyAuthToken.mockResolvedValue({
      userId: 'user-1',
      walletAddress: '0xabc',
    });
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
  });

  it('enforces unique (userId, email) for active contacts and returns a clean 409 on collision or P2002 race', async () => {
    mockPrisma.contact.findFirst.mockResolvedValueOnce({
      id: 'contact-active',
      userId: 'user-1',
      name: 'Alice Client',
      email: 'alice@example.com',
      phone: null,
      company: 'Acme',
      notes: null,
      deletedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const dupRes = await POST(
      makeRequest('POST', {
        name: 'Alice Duplicate',
        email: 'Alice@Example.com',
      }),
    );
    expect(dupRes.status).toBe(409);
    const dupBody = await dupRes.json();
    expect(dupBody.code).toBe('DUPLICATE_CONTACT_EMAIL');
    expect(mockPrisma.contact.create).not.toHaveBeenCalled();

    // Also handles concurrent Prisma P2002 unique constraint error with a clean 409
    mockPrisma.contact.findFirst.mockResolvedValueOnce(null);
    mockPrisma.contact.create.mockRejectedValueOnce({ code: 'P2002' });

    const raceRes = await POST(
      makeRequest('POST', {
        name: 'Bob Race',
        email: 'bob@example.com',
      }),
    );
    expect(raceRes.status).toBe(409);
    const raceBody = await raceRes.json();
    expect(raceBody.code).toBe('DUPLICATE_CONTACT_EMAIL');
  });

  it('excludes soft-deleted contacts from uniqueness collisions (allowing email reuse) and from GET list results', async () => {
    mockPrisma.contact.findFirst.mockResolvedValueOnce({
      id: 'contact-soft-deleted',
      userId: 'user-1',
      name: 'Old Name',
      email: 'reused@example.com',
      phone: '+1000000000',
      company: 'Old Co',
      notes: 'Old note',
      deletedAt: new Date('2026-02-01T00:00:00.000Z'),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-02-01T00:00:00.000Z'),
    });

    mockPrisma.contact.update.mockResolvedValueOnce({
      id: 'contact-soft-deleted',
      userId: 'user-1',
      name: 'New Reuse Name',
      email: 'reused@example.com',
      phone: '+1999999999',
      company: 'New Co',
      notes: 'Fresh note',
      deletedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-03-01T00:00:00.000Z'),
    });

    const reuseRes = await POST(
      makeRequest('POST', {
        name: 'New Reuse Name',
        email: 'REUSED@example.com',
        phone: '+1999999999',
        company: 'New Co',
        notes: 'Fresh note',
      }),
    );
    expect(reuseRes.status).toBe(201);
    const reuseBody = await reuseRes.json();
    expect(reuseBody.reactivated).toBe(true);
    expect(reuseBody.contact.deletedAt).toBeNull();
    expect(reuseBody.contact.name).toBe('New Reuse Name');
    expect(mockPrisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'contact-soft-deleted' },
      data: {
        name: 'New Reuse Name',
        email: 'reused@example.com',
        phone: '+1999999999',
        company: 'New Co',
        notes: 'Fresh note',
        deletedAt: null,
      },
    });

    // Verify GET filters by deletedAt: null
    mockPrisma.contact.findMany.mockResolvedValueOnce([
      {
        id: 'contact-soft-deleted',
        userId: 'user-1',
        name: 'New Reuse Name',
        email: 'reused@example.com',
        phone: '+1999999999',
        company: 'New Co',
        notes: 'Fresh note',
        deletedAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      },
    ]);

    const listRes = await GET(makeRequest('GET'));
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.total).toBe(1);
    expect(mockPrisma.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          deletedAt: null,
        }),
      }),
    );
  });

  it('validates email format and required fields before persisting (400) and rejects unauthenticated requests (401)', async () => {
    const unauthRes = await POST(makeRequest('POST', { name: 'A', email: 'a@b.com' }, '', ''));
    expect(unauthRes.status).toBe(401);

    const missingNameRes = await POST(makeRequest('POST', { email: 'valid@example.com' }));
    expect(missingNameRes.status).toBe(400);

    const invalidEmailRes = await POST(
      makeRequest('POST', { name: 'Valid Name', email: 'not-an-email' }),
    );
    expect(invalidEmailRes.status).toBe(400);
    const invalidEmailBody = await invalidEmailRes.json();
    expect(invalidEmailBody.error).toContain('Invalid email format');
    expect(mockPrisma.contact.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.contact.create).not.toHaveBeenCalled();
  });
});
