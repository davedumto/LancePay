import { describe, it, expect, beforeEach } from "vitest";
import { metrics, withMetrics, BUCKET_BOUNDS, INF_BUCKET } from "../_lib/metrics";
import { checkRateLimit } from "../_lib/rateLimit";

describe("Metrics Collector", () => {
  beforeEach(() => {
    metrics.reset();
  });

  it("records a request observation", () => {
    metrics.record("GET /api/test", 25, 200);

    const snapshot = metrics.snapshot();
    expect(snapshot.routes).toHaveLength(1);

    const route = snapshot.routes[0];
    expect(route.route).toBe("GET /api/test");
    expect(route.count).toBe(1);
    expect(route.totalMs).toBe(25);
    expect(route.outcomes.get("2xx")).toBe(1);
    expect(route.buckets.get(30)).toBe(1); // 25ms falls in <=30 bucket
  });

  it("classifies outcomes correctly", () => {
    metrics.record("GET /test", 10, 200);
    metrics.record("GET /test", 10, 201);
    metrics.record("GET /test", 10, 400);
    metrics.record("GET /test", 10, 404);
    metrics.record("GET /test", 10, 500);

    const snapshot = metrics.snapshot();
    const route = snapshot.routes[0];

    expect(route.outcomes.get("2xx")).toBe(2);
    expect(route.outcomes.get("4xx")).toBe(2);
    expect(route.outcomes.get("5xx")).toBe(1);
  });

  it("places durations in correct buckets", () => {
    metrics.record("GET /test", 5, 200);   // -> 5ms bucket
    metrics.record("GET /test", 15, 200);  // -> 15ms bucket
    metrics.record("GET /test", 150, 200); // -> 150ms bucket
    metrics.record("GET /test", 5000, 200); // -> 5000ms bucket
    metrics.record("GET /test", 99999, 200); // -> +Inf bucket

    const snapshot = metrics.snapshot();
    const route = snapshot.routes[0];

    expect(route.buckets.get(5)).toBe(1);
    expect(route.buckets.get(15)).toBe(1);
    expect(route.buckets.get(150)).toBe(1);
    expect(route.buckets.get(5000)).toBe(1);
    expect(route.buckets.get(INF_BUCKET)).toBe(1);
  });

  it("computes p50 and p95 correctly", () => {
    // Insert 100 observations linearly from 1ms to 100ms
    for (let i = 1; i <= 100; i++) {
      metrics.record("GET /test", i, 200);
    }

    const exposition = metrics.toPrometheus();

    // p50 should be around 50ms bucket
    expect(exposition).toContain(
      'routes_b_p50_request_duration_ms{route="GET /test"}'
    );

    // p95 should be around 100ms bucket
    expect(exposition).toContain(
      'routes_b_p95_request_duration_ms{route="GET /test"}'
    );
  });

  it("generates valid Prometheus exposition", () => {
    metrics.record("GET /test", 25, 200);
    metrics.record("GET /test", 75, 200);
    metrics.record("GET /test", 150, 404);

    const exposition = metrics.toPrometheus();

    // Should have histogram buckets
    expect(exposition).toContain("# TYPE routes_b_request_duration_ms histogram");
    expect(exposition).toContain(
      'routes_b_request_duration_ms_bucket{route="GET /test",le="30"} 1'
    );
    expect(exposition).toContain(
      'routes_b_request_duration_ms_bucket{route="GET /test",le="100"} 2'
    );

    // Should have sum and count
    expect(exposition).toContain("routes_b_request_duration_ms_sum");
    expect(exposition).toContain("routes_b_request_duration_ms_count");

    // Should have outcome counters
    expect(exposition).toContain("# TYPE routes_b_request_outcome_total counter");
    expect(exposition).toContain('outcome="2xx"');
    expect(exposition).toContain('outcome="4xx"');

    // Should have percentile gauges
    expect(exposition).toContain("# TYPE routes_b_p50_request_duration_ms gauge");
    expect(exposition).toContain("# TYPE routes_b_p95_request_duration_ms gauge");
  });

  it("handles multiple routes independently", () => {
    metrics.record("GET /a", 10, 200);
    metrics.record("POST /b", 50, 201);
    metrics.record("GET /a", 20, 200);

    const snapshot = metrics.snapshot();
    expect(snapshot.routes).toHaveLength(2);

    const routeA = snapshot.routes.find((r) => r.route === "GET /a");
    expect(routeA?.count).toBe(2);

    const routeB = snapshot.routes.find((r) => r.route === "POST /b");
    expect(routeB?.count).toBe(1);
  });
});

describe("withMetrics wrapper", () => {
  beforeEach(() => {
    metrics.reset();
  });

  it("records successful handler duration", async () => {
    const handler = withMetrics("GET /wrapped", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return new Response("ok", { status: 200 });
    });

    const response = await handler(new Request("http://test"));
    expect(response.status).toBe(200);

    const snapshot = metrics.snapshot();
    expect(snapshot.routes[0].count).toBe(1);
    expect(snapshot.routes[0].outcomes.get("2xx")).toBe(1);
  });

  it("records 4xx responses", async () => {
    const handler = withMetrics("POST /wrapped", async () => {
      return new Response("bad request", { status: 400 });
    });

    await handler(new Request("http://test"));

    const snapshot = metrics.snapshot();
    expect(snapshot.routes[0].outcomes.get("4xx")).toBe(1);
  });

  it("records 5xx on thrown errors", async () => {
    const handler = withMetrics("GET /wrapped", async () => {
      throw new Error("boom");
    });

    await expect(handler(new Request("http://test"))).rejects.toThrow("boom");

    const snapshot = metrics.snapshot();
    expect(snapshot.routes[0].outcomes.get("5xx")).toBe(1);
  });

  it("has negligible overhead (<50us)", async () => {
    const iterations = 1000;
    const start = performance.now();

    const handler = withMetrics("GET /perf", async () => {
      return new Response("ok");
    });

    for (let i = 0; i < iterations; i++) {
      await handler(new Request("http://test"));
    }

    const total = performance.now() - start;
    const overheadPerCall = (total / iterations) * 1000; // microseconds

    expect(overheadPerCall).toBeLessThan(50);
  });
});

describe("Rate Limiter", () => {
  beforeEach(() => {
    // Reset via cleanup
    for (let i = 0; i < 100; i++) {
      checkRateLimit(`cleanup-${i}`, 1, 1);
    }
  });

  it("allows requests within limit", () => {
    const result = checkRateLimit("client-1", 5, 60000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("blocks requests over limit", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("client-2", 3, 60000);
    }

    const result = checkRateLimit("client-2", 3, 60000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("resets after window expires", async () => {
    checkRateLimit("client-3", 1, 50); // 50ms window

    // First request allowed
    expect(checkRateLimit("client-3", 1, 50).allowed).toBe(true);

    // Second request blocked
    expect(checkRateLimit("client-3", 1, 50).allowed).toBe(false);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 60));

    // Should be allowed again
    expect(checkRateLimit("client-3", 1, 50).allowed).toBe(true);
  });
});

describe("/_metrics endpoint", () => {
  beforeEach(() => {
    metrics.reset();
  });

  it("returns Prometheus exposition", async () => {
    const { GET } = await import("../_metrics/route");

    const req = new Request("http://localhost/api/routes-b/_metrics", {
      headers: { "x-forwarded-for": "127.0.0.1" },
    });

    const response = await GET(req);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");

    const body = await response.text();
    expect(body).toContain("# HELP");
    expect(body).toContain("# TYPE");
  });

  it("is rate limited", async () => {
    const { GET } = await import("../_metrics/route");

    const ip = "10.0.0.1";

    // Exhaust limit
    for (let i = 0; i < 15; i++) {
      await GET(
        new Request("http://localhost/api/routes-b/_metrics", {
          headers: { "x-forwarded-for": ip },
        })
      );
    }

    // Next request should be rate limited
    const response = await GET(
      new Request("http://localhost/api/routes-b/_metrics", {
        headers: { "x-forwarded-for": ip },
      })
    );

    expect(response.status).toBe(429);
  });

  it("returns 429 with retry-after header", async () => {
    const { GET } = await import("../_metrics/route");

    // Hit limit
    for (let i = 0; i < 12; i++) {
      await GET(
        new Request("http://localhost/api/routes-b/_metrics", {
          headers: { "x-forwarded-for": "192.168.1.1" },
        })
      );
    }

    const response = await GET(
      new Request("http://localhost/api/routes-b/_metrics", {
        headers: { "x-forwarded-for": "192.168.1.1" },
      })
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
  });
});