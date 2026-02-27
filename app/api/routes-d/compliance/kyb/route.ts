import { NextRequest, NextResponse } from 'next/server';
import { getBusinessStatus } from '@/lib/compliance-kyb';
import { buildRateLimitResponse, getClientIp, kycStatusLimiter } from '@/lib/rate-limit';

/**
 * GET /api/routes-d/compliance/kyb
 * Query params:
 *   - businessId  (required)  unique identifier of the business being checked
 *
 * Returns a simulated verification status for the entity.  In a real
 * integration this would proxy to a third‑party KYB/compliance provider.
 */
export async function GET(req: NextRequest) {
  try {
    const clientIp = getClientIp(req);
    const statusCheck = kycStatusLimiter.check(clientIp);
    if (!statusCheck.allowed) {
      console.warn('[rate-limit] KYB status limit exceeded', { ip: clientIp });
      return buildRateLimitResponse(statusCheck);
    }

    const businessId = req.nextUrl.searchParams.get('businessId')?.trim();
    if (!businessId) {
      return NextResponse.json({ error: 'businessId query parameter is required' }, { status: 400 });
    }

    const info = await getBusinessStatus(businessId);

    return NextResponse.json({ success: true, data: info });
  } catch (err: any) {
    console.error('Error fetching KYB status:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to fetch KYB status' },
      { status: 500 }
    );
  }
}
