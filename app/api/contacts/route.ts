import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyAuthToken } from '@/lib/auth';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const MAX_PHONE_LENGTH = 40;
const MAX_COMPANY_LENGTH = 120;
const MAX_NOTES_LENGTH = 1000;

async function authenticate(req: NextRequest): Promise<{ userId: string } | NextResponse> {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const claims = await verifyAuthToken(token);
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userIdentifier = claims.userId;
  const walletAddress = claims.walletAddress?.toLowerCase();

  const user = await prisma.user.findFirst({
    where: {
      OR: [
        ...(userIdentifier ? [{ id: userIdentifier }, { privyId: userIdentifier }] : []),
        ...(walletAddress ? [{ walletAddress }] : []),
      ],
    },
    select: { id: true },
  });

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  return { userId: user.id };
}

function serializeContact(contact: {
  id: string;
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  notes: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: contact.id,
    userId: contact.userId,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    company: contact.company,
    notes: contact.notes,
    deletedAt: contact.deletedAt ? contact.deletedAt.toISOString() : null,
    createdAt: contact.createdAt.toISOString(),
    updatedAt: contact.updatedAt.toISOString(),
  };
}

function isPrismaUniqueError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'P2002'
  );
}

/**
 * GET /api/contacts
 *
 * Lists active (non-soft-deleted) contacts for the authenticated user.
 */
export async function GET(req: NextRequest) {
  try {
    const authResult = await authenticate(req);
    if (authResult instanceof NextResponse) return authResult;

    const search = req.nextUrl.searchParams.get('search')?.trim();

    const contacts = await prisma.contact.findMany({
      where: {
        userId: authResult.userId,
        deletedAt: null,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
                { company: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({
      contacts: contacts.map(serializeContact),
      total: contacts.length,
    });
  } catch (err) {
    console.error('[API /contacts GET]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/contacts
 *
 * Creates a contact for the authenticated user while:
 * - Validating email format and input fields before persistence.
 * - Enforcing uniqueness on `(userId, email)` for active contacts (`deletedAt: null`) with a clean `409`.
 * - Excluding soft-deleted contacts (`deletedAt != null`) from the uniqueness collision check by
 *   reactivating and updating the soft-deleted contact row so previously deleted emails can be reused.
 */
export async function POST(req: NextRequest) {
  try {
    const authResult = await authenticate(req);
    if (authResult instanceof NextResponse) return authResult;

    let body: Record<string, unknown>;
    try {
      const parsed = await req.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const rawName = typeof body.name === 'string' ? body.name.trim() : '';
    if (!rawName) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (rawName.length > MAX_NAME_LENGTH) {
      return NextResponse.json(
        { error: `name must not exceed ${MAX_NAME_LENGTH} characters` },
        { status: 400 },
      );
    }

    const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!rawEmail) {
      return NextResponse.json({ error: 'email is required' }, { status: 400 });
    }
    if (rawEmail.length > MAX_EMAIL_LENGTH || !EMAIL_REGEX.test(rawEmail)) {
      return NextResponse.json({ error: 'Invalid email format' }, { status: 400 });
    }

    let phone: string | null = null;
    if (body.phone !== undefined && body.phone !== null) {
      if (typeof body.phone !== 'string') {
        return NextResponse.json({ error: 'phone must be a string' }, { status: 400 });
      }
      const trimmedPhone = body.phone.trim();
      if (trimmedPhone.length > MAX_PHONE_LENGTH) {
        return NextResponse.json(
          { error: `phone must not exceed ${MAX_PHONE_LENGTH} characters` },
          { status: 400 },
        );
      }
      phone = trimmedPhone || null;
    }

    let company: string | null = null;
    if (body.company !== undefined && body.company !== null) {
      if (typeof body.company !== 'string') {
        return NextResponse.json({ error: 'company must be a string' }, { status: 400 });
      }
      const trimmedCompany = body.company.trim();
      if (trimmedCompany.length > MAX_COMPANY_LENGTH) {
        return NextResponse.json(
          { error: `company must not exceed ${MAX_COMPANY_LENGTH} characters` },
          { status: 400 },
        );
      }
      company = trimmedCompany || null;
    }

    let notes: string | null = null;
    if (body.notes !== undefined && body.notes !== null) {
      if (typeof body.notes !== 'string') {
        return NextResponse.json({ error: 'notes must be a string' }, { status: 400 });
      }
      const trimmedNotes = body.notes.trim();
      if (trimmedNotes.length > MAX_NOTES_LENGTH) {
        return NextResponse.json(
          { error: `notes must not exceed ${MAX_NOTES_LENGTH} characters` },
          { status: 400 },
        );
      }
      notes = trimmedNotes || null;
    }

    const existing = await prisma.contact.findFirst({
      where: {
        userId: authResult.userId,
        email: { equals: rawEmail, mode: 'insensitive' },
      },
    });

    if (existing) {
      if (existing.deletedAt === null) {
        return NextResponse.json(
          {
            error: 'A contact with this email already exists',
            code: 'DUPLICATE_CONTACT_EMAIL',
          },
          { status: 409 },
        );
      }

      // Soft-deleted contact exists: reactivate and replace fields so the email can be reused cleanly
      const reactivated = await prisma.contact.update({
        where: { id: existing.id },
        data: {
          name: rawName,
          email: rawEmail,
          phone,
          company,
          notes,
          deletedAt: null,
        },
      });

      return NextResponse.json(
        {
          contact: serializeContact(reactivated),
          reactivated: true,
        },
        { status: 201 },
      );
    }

    try {
      const created = await prisma.contact.create({
        data: {
          userId: authResult.userId,
          name: rawName,
          email: rawEmail,
          phone,
          company,
          notes,
          deletedAt: null,
        },
      });

      return NextResponse.json(
        {
          contact: serializeContact(created),
          reactivated: false,
        },
        { status: 201 },
      );
    } catch (dbErr) {
      if (isPrismaUniqueError(dbErr)) {
        return NextResponse.json(
          {
            error: 'A contact with this email already exists',
            code: 'DUPLICATE_CONTACT_EMAIL',
          },
          { status: 409 },
        );
      }
      throw dbErr;
    }
  } catch (err) {
    console.error('[API /contacts POST]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
