import { NextRequest, NextResponse } from 'next/server';
import { checkRequestRateLimit } from '@/lib/rate-limit';

function applySecurityHeaders(response: NextResponse, nonce: string) {
  const csp = [
    "default-src 'self'",
    "frame-src 'self' https://*.moneygram.com https://stellar.moneygram.com https://*.yellowcard.io https://stellar.yellowcard.io https://*.stellar.org",
    "connect-src 'self' https://horizon.stellar.org https://horizon-testnet.stellar.org https://*.moneygram.com https://stellar.moneygram.com https://*.yellowcard.io https://stellar.yellowcard.io https://api.yellowcard.io",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: https: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('x-nonce', nonce);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'SAMEORIGIN');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
}

function applyRateLimitHeaders(response: NextResponse, params: {
  limit: number
  remaining: number
  resetAt: number
  policyId: string
}) {
  response.headers.set('X-RateLimit-Limit', String(params.limit));
  response.headers.set('X-RateLimit-Remaining', String(params.remaining));
  response.headers.set('X-RateLimit-Reset', String(Math.floor(params.resetAt / 1000)));
  response.headers.set('X-RateLimit-Policy', params.policyId);
}

export function middleware(request: NextRequest) {

  const nonce = crypto.randomUUID();
  const rateLimit = checkRequestRateLimit(request);

  if (rateLimit && !rateLimit.allowed) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
    );

    const blocked = NextResponse.json(
      { error: 'Rate limit exceeded. Please try again shortly.' },
      { status: 429 },
    );
    blocked.headers.set('Retry-After', String(retryAfterSeconds));
    applyRateLimitHeaders(blocked, rateLimit);
    applySecurityHeaders(blocked, nonce);
    return blocked;
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  if (rateLimit) {
    applyRateLimitHeaders(response, rateLimit);
  }
  applySecurityHeaders(response, nonce);

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
