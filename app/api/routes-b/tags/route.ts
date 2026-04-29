import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getServerSession } from 'next-auth';
import { createTagSchema } from './schema';
import { TAG_LIMITS } from '../_lib/limits';
import { authOptions } from '@/lib/auth';
import { registerRoute } from '../_lib/openapi'
import { z } from 'zod'

// Register OpenAPI documentation
registerRoute({
  method: 'GET',
  path: '/tags',
  summary: 'List tags',
  description: 'Get all tags for the authenticated user with invoice counts.',
  responseSchema: z.object({
    tags: z.array(z.object({
      id: z.string(),
      name: z.string(),
      color: z.string(),
      invoiceCount: z.number(),
      createdAt: z.string()
    }))
  }),
  tags: ['tags']
})

registerRoute({
  method: 'POST',
  path: '/tags',
  summary: 'Create tag',
  description: 'Create a new tag for organizing invoices.',
  requestSchema: z.object({
    name: z.string().min(1).max(50),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#6366f1')
  }),
  responseSchema: z.object({
    id: z.string(),
    name: z.string(),
    color: z.string(),
    invoiceCount: z.number()
  }),
  tags: ['tags']
})

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const validated = createTagSchema.parse(body);

    const userId = session.user.id;

    // Atomic check + create using transaction to prevent race conditions
    const result = await prisma.$transaction(async (tx) => {
      // Count existing tags for this user
      const currentCount = await tx.tag.count({
        where: { userId },
      });

      if (currentCount >= TAG_LIMITS.MAX_TAGS_PER_USER) {
        throw new Error('TAG_LIMIT_EXCEEDED');
      }

      // Create the tag
      return tx.tag.create({
        data: {
          name: validated.name,
          color: validated.color,
          userId,
        },
      });
    });

    return NextResponse.json(
      { message: 'Tag created successfully', tag: result },
      { status: 201 }
    );
  } catch (error: any) {
    if (error.message === 'TAG_LIMIT_EXCEEDED') {
      return NextResponse.json(
        { error: `Maximum of ${TAG_LIMITS.MAX_TAGS_PER_USER} tags per user reached` },
        { status: 409 }
      );
    }
    // Zod validation errors
    if (error.name === 'ZodError') {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }

    console.error('Tag creation error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const tags = await prisma.tag.findMany({
    where: { userId: user.id },
    orderBy: { name: 'asc' },
    include: { _count: { select: { invoiceTags: true } } },
  })

  return NextResponse.json({
    tags: tags.map((tag: any) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      invoiceCount: tag._count.invoiceTags,
      createdAt: tag.createdAt,
    })),
  })
}

export async function POST(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  try {
    const body = await request.json()
    const { name, color = '#6366f1' } = body

    // Validation
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Tag name is required' }, { status: 400 })
    }
    if (name.length > 50) {
      return NextResponse.json({ error: 'Tag name must be at most 50 characters' }, { status: 400 })
    }
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
      return NextResponse.json({ error: 'Invalid hex color format' }, { status: 400 })
    }

    // Duplicate check
    const existingTag = await prisma.tag.findUnique({
      where: { userId_name: { userId: user.id, name } },
    })
    if (existingTag) {
      return NextResponse.json({ error: 'Tag with this name already exists' }, { status: 409 })
    }

    const tag = await prisma.tag.create({
      data: {
        userId: user.id,
        name,
        color,
      },
    })

    return NextResponse.json(
      {
        id: tag.id,
        name: tag.name,
        color: tag.color,
        invoiceCount: 0,
      },
      { status: 201 }
    )
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}