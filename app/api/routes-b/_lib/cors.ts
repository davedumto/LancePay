/**
 * CORS allowlist helper for routes-b public endpoints.
 *
 * Provides explicit CORS control with an allowlist of origins.
 * Rejects origins not on the allowlist (no CORS headers emitted).
 * Handles OPTIONS preflight requests.
 */

import { NextRequest, NextResponse } from "next/server";

export interface CorsOptions {
  allowOrigins: string[] | "*";
  allowMethods?: string[];
  allowHeaders?: string[];
}

/**
 * Check if an origin is allowed by the CORS policy.
 * Returns the origin if allowed, null otherwise.
 */
function isOriginAllowed(
  origin: string | null,
  allowOrigins: string[] | "*",
): string | null {
  if (!origin) return null;

  if (allowOrigins === "*") {
    return origin;
  }

  return allowOrigins.includes(origin) ? origin : null;
}

/**
 * Apply CORS headers to a response.
 * Only adds headers if the origin is on the allowlist.
 *
 * @param req - The incoming request
 * @param res - The response to modify
 * @param options - CORS configuration
 * @returns The response with CORS headers (if origin allowed), or original response
 */
export function applyCors(
  req: NextRequest,
  res: Response,
  options: CorsOptions,
): Response {
  const origin = req.headers.get("origin");
  const allowedOrigin = isOriginAllowed(origin, options.allowOrigins);

  // Origin not allowed - return response without CORS headers
  if (!allowedOrigin) {
    return res;
  }

  // Security: don't allow credentials with wildcard
  if (options.allowOrigins === "*" && req.headers.get("cookie")) {
    // Still allow the request, but don't set credentials header
    const cloned = new Response(res.body, {
      status: res.status,
      headers: res.headers,
    });
    cloned.headers.set("Access-Control-Allow-Origin", allowedOrigin);
    cloned.headers.set(
      "Access-Control-Allow-Methods",
      options.allowMethods?.join(", ") || "GET, OPTIONS",
    );
    cloned.headers.set(
      "Access-Control-Allow-Headers",
      options.allowHeaders?.join(", ") || "Content-Type",
    );
    cloned.headers.set("Access-Control-Max-Age", "86400");
    return cloned;
  }

  // Clone response to avoid mutating immutable responses
  const cloned = new Response(res.body, {
    status: res.status,
    headers: res.headers,
  });

  cloned.headers.set("Access-Control-Allow-Origin", allowedOrigin);
  cloned.headers.set(
    "Access-Control-Allow-Methods",
    options.allowMethods?.join(", ") || "GET, OPTIONS",
  );
  cloned.headers.set(
    "Access-Control-Allow-Headers",
    options.allowHeaders?.join(", ") || "Content-Type",
  );
  cloned.headers.set("Access-Control-Max-Age", "86400");

  return cloned;
}

/**
 * Handle OPTIONS preflight requests for CORS.
 * Returns a 204 No Content response with appropriate CORS headers.
 *
 * @param req - The incoming OPTIONS request
 * @param options - CORS configuration
 * @returns A 204 response with CORS headers (if origin allowed)
 */
export function handleCorsPreFlight(
  req: NextRequest,
  options: CorsOptions,
): Response {
  const origin = req.headers.get("origin");
  const allowedOrigin = isOriginAllowed(origin, options.allowOrigins);

  // Origin not allowed - return 204 without CORS headers
  if (!allowedOrigin) {
    return new NextResponse(null, { status: 204 });
  }

  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods":
        options.allowMethods?.join(", ") || "GET, OPTIONS",
      "Access-Control-Allow-Headers":
        options.allowHeaders?.join(", ") || "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

/**
 * Middleware wrapper for CORS handling.
 * Automatically handles OPTIONS preflight and applies CORS headers to responses.
 *
 * Usage:
 * ```typescript
 * export const GET = withCors(GETHandler, {
 *   allowOrigins: ['https://example.com', 'https://app.example.com'],
 *   allowMethods: ['GET', 'OPTIONS'],
 *   allowHeaders: ['Content-Type', 'Authorization'],
 * })
 *
 * export const OPTIONS = withCors(async () => new NextResponse(null, { status: 204 }), {
 *   allowOrigins: ['https://example.com'],
 * })
 * ```
 */
export function withCors<T extends (...args: any[]) => Promise<Response>>(
  handler: T,
  options: CorsOptions,
): T {
  return (async (req: NextRequest, ...args: any[]) => {
    // Handle OPTIONS preflight
    if (req.method === "OPTIONS") {
      return handleCorsPreFlight(req, options);
    }

    // Call the actual handler
    const response = await handler(req, ...args);

    // Apply CORS headers to response
    return applyCors(req, response, options);
  }) as T;
}
