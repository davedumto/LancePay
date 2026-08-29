// __tests__/api/routes-b/email-suppressions.test.ts

import { DELETE } from '@/app/api/routes-b/email-suppressions/[id]/route';
import { NextRequest } from 'next/server';

describe('DELETE /api/routes-b/email-suppressions/[id]', () => {
  it('successfully removes an email suppression on the happy path', async () => {
    const req = new NextRequest('http://localhost/api/routes-b/email-suppressions/supp_123', {
      method: 'DELETE',
    });

    const response = await DELETE(req, { params: Promise.resolve({ id: 'supp_123' }) });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.success).toBe(true);
    expect(json.data.id).toBe('supp_123');
  });

  it('returns a validation error if the ID is missing or malformed', async () => {
    const req = new NextRequest('http://localhost/api/routes-b/email-suppressions/', {
      method: 'DELETE',
    });

    const response = await DELETE(req, { params: Promise.resolve({ id: '' }) });
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
  });
});