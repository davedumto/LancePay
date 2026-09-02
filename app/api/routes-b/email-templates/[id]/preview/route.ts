import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import Handlebars from 'handlebars'; 
import prisma from '@/lib/prisma';
import { getCurrentUser } from '@/lib/auth'; // Adjust based on your auth implementation

const previewSchema = z.object({
  sampleData: z.record(z.any()).default({}),
});

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Auth Check
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'You must be logged in to perform this action.' },
        { status: 401 }
      );
    }

    // Request Validation
    const body = await request.json().catch(() => ({}));
    const validation = previewSchema.safeParse(body);
    
    if (!validation.success) {
      return NextResponse.json(
        { 
          error: 'Bad Request', 
          message: 'Invalid sample data provided.',
          details: validation.error.format() 
        },
        { status: 400 }
      );
    }

    // Fetch Template & Ownership Check
    const template = await prisma.emailTemplate.findUnique({
      where: { id: params.id },
    });

    if (!template) {
      return NextResponse.json(
        { error: 'Not Found', message: 'Email template not found.' },
        { status: 404 }
      );
    }

    if (template.userId !== user.id) {
      return NextResponse.json(
        { error: 'Forbidden', message: 'You do not have permission to access this template.' },
        { status: 403 }
      );
    }

    // Render Template
    const compiledTemplate = Handlebars.compile(template.content || '');
    const renderedHtml = compiledTemplate(validation.data.sampleData);

    // Success Response
    return NextResponse.json(
      { 
        data: { 
          renderedHtml,
          templateId: template.id 
        } 
      },
      { status: 200 }
    );

  } catch (error) {
    console.error('[EMAIL_TEMPLATE_PREVIEW_POST]', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: 'An unexpected error occurred.' },
      { status: 500 }
    );
  }
}