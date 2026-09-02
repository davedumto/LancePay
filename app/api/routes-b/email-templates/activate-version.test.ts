import { NextRequest } from 'next/server';
import { POST } from '@/app/api/routes-b/email-templates/[id]/versions/[v]/activate/route';
import { verifyAuthToken } from '@/lib/auth';
import prisma from '@/lib/prisma';

jest.mock('@/lib/auth');
jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    emailTemplate: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    emailTemplateVersion: {
      findUnique: jest.fn(),
    },
  },
}));

describe('POST /api/routes-b/email-templates/[id]/versions/[v]/activate', () => {
  const mockParams = { params: { id: 'template-123', v: 'version-456' } };
  const mockClaims = { userId: 'privy-user-789' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createRequest = (withAuth = true) => {
    const headers = new Headers();
    if (withAuth) headers.set('Authorization', 'Bearer valid-token');
    return new NextRequest('http://localhost/api/routes-b/email-templates/template-123/versions/version-456/activate', {
      method: 'POST',
      headers,
    });
  };

  it('should return 401 if missing auth token', async () => {
    const response = await POST(createRequest(false), mockParams);
    expect(response.status).toBe(401);
  });

  it('should return 404 if parent template is not found', async () => {
    (verifyAuthToken as jest.Mock).mockResolvedValue(mockClaims);
    (prisma.emailTemplate.findUnique as jest.Mock).mockResolvedValue(null);

    const response = await POST(createRequest(), mockParams);
    expect(response.status).toBe(404);
  });

  it('should return 403 if user does not own the parent template', async () => {
    (verifyAuthToken as jest.Mock).mockResolvedValue(mockClaims);
    (prisma.emailTemplate.findUnique as jest.Mock).mockResolvedValue({ 
      id: 'template-123', 
      userId: 'different-user' 
    });

    const response = await POST(createRequest(), mockParams);
    expect(response.status).toBe(403);
  });

  it('should return 404 if the target version does not exist', async () => {
    (verifyAuthToken as jest.Mock).mockResolvedValue(mockClaims);
    (prisma.emailTemplate.findUnique as jest.Mock).mockResolvedValue({ 
      id: 'template-123', 
      userId: mockClaims.userId 
    });
    (prisma.emailTemplateVersion.findUnique as jest.Mock).mockResolvedValue(null);

    const response = await POST(createRequest(), mockParams);
    const data = await response.json();
    
    expect(response.status).toBe(404);
    expect(data.error).toBe('Not Found');
  });

  it('should return 404 if target version belongs to a different template', async () => {
    (verifyAuthToken as jest.Mock).mockResolvedValue(mockClaims);
    (prisma.emailTemplate.findUnique as jest.Mock).mockResolvedValue({ 
      id: 'template-123', 
      userId: mockClaims.userId 
    });
    (prisma.emailTemplateVersion.findUnique as jest.Mock).mockResolvedValue({
      id: 'version-456',
      templateId: 'wrong-template-id' // Mismatched relation
    });

    const response = await POST(createRequest(), mockParams);
    expect(response.status).toBe(404);
  });

  it('should return 200 and update the template on success', async () => {
    (verifyAuthToken as jest.Mock).mockResolvedValue(mockClaims);
    (prisma.emailTemplate.findUnique as jest.Mock).mockResolvedValue({ 
      id: 'template-123', 
      userId: mockClaims.userId 
    });
    (prisma.emailTemplateVersion.findUnique as jest.Mock).mockResolvedValue({
      id: 'version-456',
      templateId: 'template-123'
    });
    (prisma.emailTemplate.update as jest.Mock).mockResolvedValue({
      id: 'template-123',
      activeVersionId: 'version-456'
    });

    const response = await POST(createRequest(), mockParams);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.data.activeVersionId).toBe('version-456');
    expect(prisma.emailTemplate.update).toHaveBeenCalledWith({
      where: { id: 'template-123' },
      data: { activeVersionId: 'version-456' },
    });
  });
});