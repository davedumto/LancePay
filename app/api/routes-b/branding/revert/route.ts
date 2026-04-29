import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthToken } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { revertBrandingToDefaults } from '../../_lib/branding';

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '');
    const claims = await verifyAuthToken(authToken || '');

    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const result = await revertBrandingToDefaults(user.id);

    // Audit log the revert action with previous values
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: 'BRANDING_REVERT_TO_DEFAULTS',
        entityType: 'Branding',
        entityId: user.id,
        oldValues: result.previous,
        newValues: result.current,
        metadata: { reason: 'User requested revert to defaults' },
      },
    });

    return NextResponse.json({
      message: 'Branding reverted to defaults successfully',
      branding: result.current,
    });
  } catch (error: any) {
    console.error('Branding revert error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}