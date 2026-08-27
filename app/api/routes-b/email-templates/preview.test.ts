import { NextRequest } from 'next/server';
import { POST } from '@/app/api/routes-b/email-templates/[id]/preview/route';
import { getCurrentUser } from '@/lib/auth';
import prisma from '@/lib/prisma';

jest.mock('@/lib/auth');
jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    emailTemplate: {
      findUnique: jest.fn(),
    },
  },
}));

describe('POST /api/routes-b/email-templates/[id]/preview', () => {
  const mockParams = { params: { id: 'template-123' } };
  const mockUser = { id: 'user-456' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createMockRequest = (body: any = {}) => {
    return new NextRequest('http://localhost/api/routes-b/email-templates/template-123/preview', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  };

  it('should return 401 if user is not authenticated', async () => {
    (getCurrentUser as jest.Mock).mockResolvedValue(null);
    
    const request = createMockRequest();
    const response = await POST(request, mockParams);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('should return 404 if template does not exist', async () => {
    (getCurrentUser as jest.Mock).mockResolvedValue(mockUser);
    (prisma.emailTemplate.findUnique as jest.Mock).mockResolvedValue(null);

    const request = createMockRequest({ sampleData: {} });
    const response = await POST(request, mockParams);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe('Not Found');
  });

  it('should return 403 if user does not own the template', async () => {
    (getCurrentUser as jest.Mock).mockResolvedValue(mockUser);
    (prisma.emailTemplate.findUnique as jest.Mock).mockResolvedValue({
      id: 'template-123',
      userId: 'different-user-789',
      content: 'Hello {{name}}',
    });

    const request = createMockRequest({ sampleData: {} });
    const response = await POST(request, mockParams);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error).toBe('Forbidden');
  });

  it('should return 200 and rendered HTML on the happy path', async () => {
    (getCurrentUser as jest.Mock).mockResolvedValue(mockUser);
    (prisma.emailTemplate.findUnique as jest.Mock).mockResolvedValue({
      id: 'template-123',
      userId: mockUser.id,
      content: 'Hello {{name}}, your balance is {{balance}}.',
    });

    const request = createMockRequest({
      sampleData: {
        name: 'Alice',
        balance: '$100',
      },
    });

    const response = await POST(request, mockParams);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.data.renderedHtml).toBe('Hello Alice, your balance is $100.');
  });
});