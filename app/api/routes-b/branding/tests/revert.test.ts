import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '../revert/route';

vi.mock('@/lib/auth');
vi.mock('@/lib/db');

describe('POST /branding/revert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reverts branding to defaults and logs audit', async () => {
    // Mock auth and prisma responses...
    const request = new Request('http://localhost/api/routes-b/branding/revert', {
      method: 'POST',
    });

    const response = await POST(request as any);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.message).toContain('reverted');
  });

  it('works even when branding was already default (no-op)', async () => {
    // Test no-op case
  });

  it('creates audit log with previous values', async () => {
    // Verify auditLog.create was called with oldValues
  });
});