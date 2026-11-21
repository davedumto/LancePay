import { NextRequest, NextResponse } from 'next/server';
import { checkRequestRateLimit, rateLimitExceededBody, rateLimitHeaders } from '@/lib/rate-limit';

function applySecurityHeaders(response: NextResponse, nonce: string) {
  const csp = [
    "default-src 'self'",
    "frame-src 'self' https://*.moonpay.com https://*.stellar.org",
    "connect-src 'self' https://horizon.stellar.org https://horizon-testnet.stellar.org https://*.moonpay.com",
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

export function middleware(request: NextRequest) {

  const nonce = crypto.randomUUID();
  const rateLimit = checkRequestRateLimit(request);

  if (rateLimit && !rateLimit.allowed) {
    const blocked = NextResponse.json(rateLimitExceededBody(rateLimit), {
      status: 429,
      headers: rateLimitHeaders(rateLimit),
    });
    applySecurityHeaders(blocked, nonce);
    return blocked;
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  if (rateLimit) {
    const { 'Retry-After': _retryAfter, ...headers } = rateLimitHeaders(rateLimit);
    for (const [key, value] of Object.entries(headers)) {
      response.headers.set(key, value);
    }
  }
  applySecurityHeaders(response, nonce);

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
