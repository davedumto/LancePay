import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/routes-b/email-suppressions/route';
import { verifyAuthToken } from '@/lib/auth';
import prisma from '@/lib/prisma';

jest.mock('@/lib/auth');
jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    emailSuppression: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
    },
  },
}));

describe('/api/routes-b/email-suppressions', () => {
  const mockClaims = { userId: 'privy-user-123' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET Method', () => {
    const createGetRequest = (withAuth = true) => {
      const headers = new Headers();
      if (withAuth) headers.set('Authorization', 'Bearer valid-token');
      return new NextRequest('http://localhost/api/routes-b/email-suppressions', { 
        method: 'GET',
        headers 
      });
    };

    it('should return 401 if missing auth token', async () => {
      const response = await GET(createGetRequest(false));
      expect(response.status).toBe(401);
    });

    it('should return 200 and a list of suppressions', async () => {
      (verifyAuthToken as jest.Mock).mockResolvedValue(mockClaims);
      (prisma.emailSuppression.findMany as jest.Mock).mockResolvedValue([
        { id: 'supp-1', email: 'test@example.com' }
      ]);
      
      const response = await GET(createGetRequest());
      const data = await response.json();
      
      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(1);
      expect(prisma.emailSuppression.findMany).toHaveBeenCalledWith({
        where: { userId: mockClaims.userId },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('POST Method', () => {
    const createPostRequest = (body: any, withAuth = true) => {
      const headers = new Headers();
      if (withAuth) headers.set('Authorization', 'Bearer valid-token');
      return new NextRequest('http://localhost/api/routes-b/email-suppressions', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    };

    const validPayload = { email: 'block@example.com', reason: 'Unsubscribed' };

    it('should return 401 if unauthorized', async () => {
      (verifyAuthToken as jest.Mock).mockResolvedValue(null);
      const response = await POST(createPostRequest(validPayload));
      expect(response.status).toBe(401);
    });

    it('should return 400 if email is invalid or missing', async () => {
      (verifyAuthToken as jest.Mock).mockResolvedValue(mockClaims);
      const response = await POST(createPostRequest({ email: 'not-an-email' })); 
      expect(response.status).toBe(400);
    });

    it('should return 409 if suppression already exists', async () => {
      (verifyAuthToken as jest.Mock).mockResolvedValue(mockClaims);
      (prisma.emailSuppression.findFirst as jest.Mock).mockResolvedValue({ id: 'existing' });
      
      const response = await POST(createPostRequest(validPayload));
      expect(response.status).toBe(409);
    });

    it('should return 201 and create suppression on success', async () => {
      (verifyAuthToken as jest.Mock).mockResolvedValue(mockClaims);
      (prisma.emailSuppression.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.emailSuppression.create as jest.Mock).mockResolvedValue({
        id: 'new-supp',
        ...validPayload,
        userId: mockClaims.userId,
      });
      
      const response = await POST(createPostRequest(validPayload));
      const data = await response.json();
      
      expect(response.status).toBe(201);
      expect(data.data.email).toBe('block@example.com');
      expect(prisma.emailSuppression.create).toHaveBeenCalledTimes(1);
    });
  });
});