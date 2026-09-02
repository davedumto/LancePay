import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { verifyAuthToken } from '@/lib/auth';

const createVersionSchema = z.object({
  subject: z.string().min(1, 'Subject is required'),
  content: z.string().min(1, 'Content is required'),
  versionNote: z.string().optional(),
});

// GET: List all versions for a specific template
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Extract and verify Privy token
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    
    if (!token) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Missing authentication token.' },
        { status: 401 }
      );
    }

    const claims = await verifyAuthToken(token);
    if (!claims) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Invalid or expired token.' },
        { status: 401 }
      );
    }

    const template = await prisma.emailTemplate.findUnique({
      where: { id: params.id },
    });

    if (!template) {
      return NextResponse.json(
        { error: 'Not Found', message: 'Email template not found.' },
        { status: 404 }
      );
    }

    // Match template ownership against Privy's userId
    if (template.userId !== claims.userId) {
      return NextResponse.json(
        { error: 'Forbidden', message: 'You do not have permission to access this template.' },
        { status: 403 }
      );
    }

    const versions = await prisma.emailTemplateVersion.findMany({
      where: { templateId: params.id },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({ data: versions }, { status: 200 });
  } catch (error) {
    console.error('[EMAIL_TEMPLATE_VERSIONS_GET]', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: 'An unexpected error occurred.' },
      { status: 500 }
    );
  }
}

// POST: Create a new version for a specific template
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Extract and verify Privy token
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    
    if (!token) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Missing authentication token.' },
        { status: 401 }
      );
    }

    const claims = await verifyAuthToken(token);
    if (!claims) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Invalid or expired token.' },
        { status: 401 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const validation = createVersionSchema.safeParse(body);
    
    if (!validation.success) {
      return NextResponse.json(
        { 
          error: 'Bad Request', 
          message: 'Invalid request payload.',
          details: validation.error.format() 
        },
        { status: 400 }
      );
    }

    const template = await prisma.emailTemplate.findUnique({
      where: { id: params.id },
    });

    if (!template) {
      return NextResponse.json(
        { error: 'Not Found', message: 'Email template not found.' },
        { status: 404 }
      );
    }

    if (template.userId !== claims.userId) {
      return NextResponse.json(
        { error: 'Forbidden', message: 'You do not have permission to modify this template.' },
        { status: 403 }
      );
    }

    const newVersion = await prisma.emailTemplateVersion.create({
      data: {
        templateId: params.id,
        subject: validation.data.subject,
        content: validation.data.content,
        versionNote: validation.data.versionNote,
      },
    });

    return NextResponse.json({ data: newVersion }, { status: 201 });
  } catch (error) {
    console.error('[EMAIL_TEMPLATE_VERSIONS_POST]', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: 'An unexpected error occurred.' },
      { status: 500 }
    );
  }
}