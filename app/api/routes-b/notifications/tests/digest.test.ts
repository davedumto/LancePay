import { describe, it, expect, vi } from 'vitest';
import { GET } from '../digest/route';

vi.mock('@/lib/auth');
vi.mock('@/lib/db');

describe('GET /notifications/digest', () => {
  it('returns digest for today by default', async () => {
    // Mock setup...
  });

  it('rejects future dates', async () => {
    // test future date → 400
  });

  it('returns empty digest when no notifications', async () => {
    // expect totalsByType: {}, top: []
  });

  it('groups correctly by type with counts', async () => {
    // multi-type test
  });
});