import { metrics } from "../_lib/metrics";
import { checkRateLimit } from "../_lib/rateLimit";

export const dynamic = "force-dynamic";

/**
 * GET /api/routes-b/_metrics
 * Returns Prometheus-formatted metrics text exposition.
 * Unauthenticated but rate-limited.
 */
export async function GET(req: Request) {
  // Extract client IP for rate limiting
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || "unknown";
  const key = `metrics:${ip}`;

  const limit = checkRateLimit(key, 10, 60000); // 10 req/min

  if (!limit.allowed) {
    return new Response("Rate limit exceeded", {
      status: 429,
      headers: {
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(Math.ceil(limit.resetAt / 1000)),
        "Retry-After": String(Math.ceil((limit.resetAt - Date.now()) / 1000)),
      },
    });
  }

  const exposition = metrics.toPrometheus();

  return new Response(exposition, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-RateLimit-Remaining": String(limit.remaining),
    },
  });
}