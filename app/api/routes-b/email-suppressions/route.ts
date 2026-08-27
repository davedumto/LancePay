import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { verifyAuthToken } from '@/lib/auth';

const addSuppressionSchema = z.object({
  email: z.string().email('Valid email address is required'),
  reason: z.string().optional(),
});

// GET: List all email suppressions for the authenticated user
export async function GET(request: NextRequest) {
  try {
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

    const suppressions = await prisma.emailSuppression.findMany({
      where: { userId: claims.userId },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({ data: suppressions }, { status: 200 });
  } catch (error) {
    console.error('[EMAIL_SUPPRESSIONS_GET]', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: 'An unexpected error occurred.' },
      { status: 500 }
    );
  }
}

// POST: Add a new email suppression
export async function POST(request: NextRequest) {
  try {
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
    const validation = addSuppressionSchema.safeParse(body);
    
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

    // Check if suppression already exists for this user
    const existingSuppression = await prisma.emailSuppression.findFirst({
      where: {
        userId: claims.userId,
        email: validation.data.email,
      },
    });

    if (existingSuppression) {
      return NextResponse.json(
        { error: 'Conflict', message: 'This email is already suppressed.' },
        { status: 409 }
      );
    }

    const newSuppression = await prisma.emailSuppression.create({
      data: {
        userId: claims.userId,
        email: validation.data.email,
        reason: validation.data.reason,
      },
    });

    return NextResponse.json({ data: newSuppression }, { status: 201 });
  } catch (error) {
    console.error('[EMAIL_SUPPRESSIONS_POST]', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: 'An unexpected error occurred.' },
      { status: 500 }
    );
  }
}