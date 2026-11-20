/**
 * Middleware Architecture & Security Header Policy
 *
 * This middleware splits handling between API routes and HTML page routes:
 * - API Routes (/api/*): Protected by rate limiting and strict API security headers
 *   (X-Content-Type-Options, X-Frame-Options, HSTS, Permissions-Policy). HTML CSP and
 *   nonce generation are omitted to avoid unnecessary computation and header noise.
 * - Page Routes: Enforce full HTML Content-Security-Policy (CSP) with dynamic per-request
 *   cryptographic nonces for script execution, Privy authentication and embedded wallet
 *   origins, configured Horizon RPC endpoints, and frame protection.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkRequestRateLimit } from '@/lib/rate-limit';

const PRIVY_AUTH_ORIGINS = [
  'https://auth.privy.io',
  'https://*.privy.io',
  'wss://*.privy.io',
];

const PRIVY_FRAME_ORIGINS = [
  'https://auth.privy.io',
  'https://*.privy.io',
  'https://verify.privy.io',
];

function getCustomHorizonOrigin(): string | null {
  const customHorizon = process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL;
  if (!customHorizon) return null;
  try {
    const url = new URL(customHorizon);
    return url.origin;
  } catch {
    return null;
  }
}

function applyCommonSecurityHeaders(response: NextResponse) {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (process.env.NODE_ENV === 'production') {
    response.headers.set(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload'
    );
  }
}

function applyApiSecurityHeaders(response: NextResponse) {
  applyCommonSecurityHeaders(response);
  response.headers.set('X-Frame-Options', 'DENY');
}

function applyPageSecurityHeaders(response: NextResponse, nonce: string) {
  applyCommonSecurityHeaders(response);
  response.headers.set('X-Frame-Options', 'SAMEORIGIN');

  const connectSrcList = [
    "'self'",
    'https://horizon.stellar.org',
    'https://horizon-testnet.stellar.org',
    'https://*.moonpay.com',
    ...PRIVY_AUTH_ORIGINS,
  ];

  const customHorizon = getCustomHorizonOrigin();
  if (customHorizon && !connectSrcList.includes(customHorizon)) {
    connectSrcList.push(customHorizon);
  }

  const frameSrcList = [
    "'self'",
    'https://*.moonpay.com',
    'https://*.stellar.org',
    ...PRIVY_FRAME_ORIGINS,
  ];

  const csp = [
    "default-src 'self'",
    `frame-src ${frameSrcList.join(' ')}`,
    `connect-src ${connectSrcList.join(' ')}`,
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: https: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "report-uri /api/csp-report",
  ].join('; ');

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('x-nonce', nonce);
}

function applyRateLimitHeaders(
  response: NextResponse,
  params: {
    limit: number;
    remaining: number;
    resetAt: number;
    policyId: string;
  }
) {
  response.headers.set('X-RateLimit-Limit', String(params.limit));
  response.headers.set('X-RateLimit-Remaining', String(params.remaining));
  response.headers.set('X-RateLimit-Reset', String(Math.floor(params.resetAt / 1000)));
  response.headers.set('X-RateLimit-Policy', params.policyId);
}

export function middleware(request: NextRequest) {
  const isApiRoute = request.nextUrl.pathname.startsWith('/api');
  const rateLimit = checkRequestRateLimit(request);

  if (rateLimit && !rateLimit.allowed) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((rateLimit.resetAt - Date.now()) / 1000)
    );

    const blocked = NextResponse.json(
      { error: 'Rate limit exceeded. Please try again shortly.' },
      { status: 429 }
    );
    blocked.headers.set('Retry-After', String(retryAfterSeconds));
    applyRateLimitHeaders(blocked, rateLimit);

    if (isApiRoute) {
      applyApiSecurityHeaders(blocked);
    } else {
      const nonce = crypto.randomUUID();
      applyPageSecurityHeaders(blocked, nonce);
    }
    return blocked;
  }

  if (isApiRoute) {
    const response = NextResponse.next();
    if (rateLimit) {
      applyRateLimitHeaders(response, rateLimit);
    }
    applyApiSecurityHeaders(response);
    return response;
  }

  const nonce = crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  if (rateLimit) {
    applyRateLimitHeaders(response, rateLimit);
  }
  applyPageSecurityHeaders(response, nonce);

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
