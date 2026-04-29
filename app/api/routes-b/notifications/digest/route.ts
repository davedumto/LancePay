import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthToken } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getDailyDigest } from '../../_lib/notifications';

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '');
    const claims = await verifyAuthToken(authToken || '');

    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, timezone: true },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const dateParam = request.nextUrl.searchParams.get('date'); // expected: YYYY-MM-DD

    const digest = await getDailyDigest(user.id, dateParam, user.timezone || 'Africa/Lagos');

    return NextResponse.json(digest);
  } catch (error: any) {
    if (error.message === 'FUTURE_DATE_NOT_ALLOWED') {
      return NextResponse.json(
        { error: 'Future dates are not allowed' },
        { status: 400 }
      );
    }

    console.error('Daily digest error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}