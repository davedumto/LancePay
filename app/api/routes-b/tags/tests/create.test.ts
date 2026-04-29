import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '../route';
import { prisma } from '@/lib/db'

// Mock auth and prisma
vi.mock('@/lib/prisma', () => ({
  prisma: {
    tag: {
      count: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}));

describe('POST /api/routes-b/tags', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a valid tag successfully', async () => {
    const mockSession = { user: { id: mockUserId } };
    (require('next-auth').getServerSession as any).mockResolvedValue(mockSession);

    (prisma.$transaction as any).mockImplementation(async (cb: any) => {
      (prisma.tag.count as any).mockResolvedValue(5);
      return { id: 'tag_new', name: 'work', color: '#3b82f6', userId: mockUserId };
    });

    const request = new Request('http://localhost/api/routes-b/tags', {
      method: 'POST',
      body: JSON.stringify({ name: ' Work ', color: '#3b82f6' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(request as any);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.tag.name).toBe('work');
    expect(data.tag.color).toBe('#3b82f6');
  });

  it('rejects invalid hex color', async () => {
    const request = new Request('http://localhost/api/routes-b/tags', {
      method: 'POST',
      body: JSON.stringify({ name: 'test', color: '#abc' }), // 3 chars
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(request as any);
    expect(response.status).toBe(400);
  });

  it('rejects empty name after trim', async () => {
    const request = new Request('http://localhost/api/routes-b/tags', {
      method: 'POST',
      body: JSON.stringify({ name: '   ', color: '#ffffff' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(request as any);
    expect(response.status).toBe(400);
  });

  it('rejects name longer than 32 chars', async () => {
    const longName = 'a'.repeat(33);
    const request = new Request('http://localhost/api/routes-b/tags', {
      method: 'POST',
      body: JSON.stringify({ name: longName, color: '#000000' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(request as any);
    expect(response.status).toBe(400);
  });

  it('returns 409 when user is at tag limit', async () => {
    const mockSession = { user: { id: mockUserId } };
    (require('next-auth').getServerSession as any).mockResolvedValue(mockSession);

    (prisma.$transaction as any).mockImplementation(async () => {
      throw new Error('TAG_LIMIT_EXCEEDED');
    });

    const request = new Request('http://localhost/api/routes-b/tags', {
      method: 'POST',
      body: JSON.stringify({ name: 'newtag', color: '#ff0000' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(request as any);
    expect(response.status).toBe(409);
  });
});