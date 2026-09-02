import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/routes-b/email-templates/[id]/versions/route';
import { verifyAuthToken } from '@/lib/auth';
import prisma from '@/lib/prisma';

jest.mock('@/lib/auth');
jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    emailTemplate: {
      findUnique: jest.fn(),
    },
    emailTemplateVersion: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
  },
}));

describe('/api/routes-b/email-templates/[id]/versions', () => {
  const mockParams = { params: { id: 'template-123' } };
  const mockClaims = { userId: 'privy-user-456' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET Method', () => {
    const createGetRequest = (withAuth = true) => {
      const headers = new Headers();
      if (withAuth) headers.set('Authorization', 'Bearer valid-token');
      return new NextRequest('http://localhost/api/routes-b/email-templates/template-123/versions', { 
        method: 'GET',
        headers 
      });
    };

    it('should return 401 if missing auth token', async () => {
      const response = await GET(createGetRequest(false), mockParams);
      expect(response.status).toBe(401);
    });

    it('should return 401 if token is invalid', async () => {
      (verifyAuthToken as jest.Mock).mockResolvedValue(null);
      const response = await GET(createGetRequest(), mockParams);
      expect(response.status).toBe(401);
    });

    it('should return 404 if template is not found', async () => {
      (verifyAuthToken as jest.Mock).mockResolvedValue(mockClaims);
      (prisma.emailTemplate.findUnique as jest.Mock).mockResolvedValue(null);
      
      const response = await GET(createGetRequest(), mockParams);
      expect(response.status).toBe(404);
    });

    it('should return 403 if user does not own the template', async () => {
      (verifyAuthToken as jest.Mock).mockResolvedValue(mockClaims);
      (prisma.emailTemplate.findUnique as jest.Mock).mockResolvedValue({ id: 'template-123', userId: 'other-user' });
      
      const response = await GET(createGetRequest(), mockParams);
      expect(response.status).toBe(403);
    });

    it('should return 200 with list of versions on success', async () => {
      (verifyAuthToken as jest.Mock).mockResolvedValue(mockClaims);
      (prisma.emailTemplate.findUnique as jest.Mock).mockResolvedValue({ id: 'template-123', userId: mockClaims.userId });
      (prisma.emailTemplateVersion.findMany as jest.Mock).mockResolvedValue([
        { id: 'v1', subject: 'Test' }
      ]);
      
      const response = await GET(createGetRequest(), mockParams);
      const data = await response.json();
      
      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(1);
    });
  });

  describe('POST Method', () => {
    const createPostRequest = (body: any, withAuth = true) => {
      const headers = new Headers();
      if (withAuth) headers.set('Authorization', 'Bearer valid-token');
      return new NextRequest('http://localhost/api/routes-b/email-templates/template-123/versions', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    };

    const validPayload = { subject: 'Welcome', content: '<h1>Hello</h1>' };

    it('should return 401 if unauthorized', async () => {
      (verifyAuthToken as jest.Mock).mockResolvedValue(null);
      const response = await POST(createPostRequest(validPayload), mockParams);
      expect(response.status).toBe(401);
    });

    it('should return 400 if validation fails', async () => {
      (verifyAuthToken as jest.Mock).mockResolvedValue(mockClaims);
      const response = await POST(createPostRequest({ subject: 'Welcome' }), mockParams); 
      expect(response.status).toBe(400);
    });

    it('should return 403 if user does not own the template', async () => {
      (verifyAuthToken as jest.Mock).mockResolvedValue(mockClaims);
      (prisma.emailTemplate.findUnique as jest.Mock).mockResolvedValue({ id: 'template-123', userId: 'other-user' });
      
      const response = await POST(createPostRequest(validPayload), mockParams);
      expect(response.status).toBe(403);
    });

    it('should return 201 and create version on success', async () => {
      (verifyAuthToken as jest.Mock).mockResolvedValue(mockClaims);
      (prisma.emailTemplate.findUnique as jest.Mock).mockResolvedValue({ id: 'template-123', userId: mockClaims.userId });
      (prisma.emailTemplateVersion.create as jest.Mock).mockResolvedValue({
        id: 'new-v1',
        ...validPayload
      });
      
      const response = await POST(createPostRequest(validPayload), mockParams);
      const data = await response.json();
      
      expect(response.status).toBe(201);
      expect(data.data.id).toBe('new-v1');
    });
  });
});