import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { verifyAuthToken } from '@/lib/auth';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; v: string } }
) {
  try {
    // 1. Extract and verify Privy token
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

    // 2. Verify template existence and ownership
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

    // 3. Verify the target version exists and belongs to this template
    const targetVersion = await prisma.emailTemplateVersion.findUnique({
      where: { id: params.v },
    });

    if (!targetVersion || targetVersion.templateId !== params.id) {
      return NextResponse.json(
        { error: 'Not Found', message: 'Email template version not found.' },
        { status: 404 }
      );
    }

    // 4. Activate the version
    // NOTE: Adjust 'activeVersionId' to match your exact Prisma schema field name
    const updatedTemplate = await prisma.emailTemplate.update({
      where: { id: params.id },
      data: { activeVersionId: params.v }, 
    });

    return NextResponse.json({ data: updatedTemplate }, { status: 200 });
  } catch (error) {
    console.error('[EMAIL_TEMPLATE_VERSION_ACTIVATE]', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: 'An unexpected error occurred.' },
      { status: 500 }
    );
  }
}