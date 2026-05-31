/**
 * In-process HDR-style metrics collector for routes-b.
 * Maintains per-route latency buckets with negligible overhead (<50us per request).
 * 
 * Scope: app/api/routes-b/_lib/ ONLY — no external dependencies.
 */

// Types 

export type Outcome = "2xx" | "4xx" | "5xx";

export interface RouteMetrics {
  route: string;
  count: number;
  totalMs: number;
  buckets: Map<number, number>; // upperBoundMs -> count
  outcomes: Map<Outcome, number>;
}

export interface MetricsSnapshot {
  routes: RouteMetrics[];
  collectedAt: Date;
}

// Constants 

/** HDR-style bucket boundaries in milliseconds (exponential-ish) */
export const BUCKET_BOUNDS = [
  1, 2, 5, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500,
  2000, 3000, 5000, 10000,
];

/** Maximum bucket for overflow */
export const INF_BUCKET = Infinity;

// In-Memory Store 

class MetricsCollector {
  private store = new Map<string, RouteMetrics>();

  /** Record a single request observation */
  record(route: string, durationMs: number, statusCode: number): void {
    const outcome = this.classifyOutcome(statusCode);
    const metrics = this.getOrCreate(route);

    metrics.count += 1;
    metrics.totalMs += durationMs;

    // Increment outcome counter
    metrics.outcomes.set(outcome, (metrics.outcomes.get(outcome) || 0) + 1);

    // Find and increment bucket
    const bucket = this.findBucket(durationMs);
    metrics.buckets.set(bucket, (metrics.buckets.get(bucket) || 0) + 1);
  }

  /** Get or create metrics for a route */
  private getOrCreate(route: string): RouteMetrics {
    if (!this.store.has(route)) {
      this.store.set(route, {
        route,
        count: 0,
        totalMs: 0,
        buckets: new Map(),
        outcomes: new Map(),
      });
    }
    return this.store.get(route)!;
  }

  /** Classify HTTP status into outcome bucket */
  private classifyOutcome(status: number): Outcome {
    if (status >= 200 && status < 300) return "2xx";
    if (status >= 400 && status < 500) return "4xx";
    return "5xx";
  }

  /** Find the bucket upper bound for a duration */
  private findBucket(durationMs: number): number {
    for (const bound of BUCKET_BOUNDS) {
      if (durationMs <= bound) return bound;
    }
    return INF_BUCKET;
  }

  /** Compute p50/p95 from buckets */
  private computePercentile(
    metrics: RouteMetrics,
    percentile: number
  ): number | null {
    if (metrics.count === 0) return null;

    const target = Math.ceil((metrics.count * percentile) / 100);
    let cumulative = 0;

    // Sort buckets by upper bound
    const sortedBuckets = Array.from(metrics.buckets.entries()).sort(
      (a, b) => a[0] - b[0]
    );

    for (const [bound, count] of sortedBuckets) {
      cumulative += count;
      if (cumulative >= target) {
        return bound === INF_BUCKET ? BUCKET_BOUNDS[BUCKET_BOUNDS.length - 1] : bound;
      }
    }

    return null;
  }

  /** Get snapshot of all metrics */
  snapshot(): MetricsSnapshot {
    const routes: RouteMetrics[] = [];

    for (const [route, metrics] of this.store) {
      routes.push({
        route,
        count: metrics.count,
        totalMs: metrics.totalMs,
        buckets: new Map(metrics.buckets),
        outcomes: new Map(metrics.outcomes),
      });
    }

    return { routes, collectedAt: new Date() };
  }

  /** Export as Prometheus text exposition */
  toPrometheus(): string {
    const snapshot = this.snapshot();
    const lines: string[] = [];

    lines.push("# HELP routes_b_request_duration_ms Request duration in milliseconds");
    lines.push("# TYPE routes_b_request_duration_ms histogram");

    for (const metrics of snapshot.routes) {
      const routeLabel = `route="${this.escapeLabel(metrics.route)}"`;

      // Bucket counts
      for (const bound of BUCKET_BOUNDS) {
        const count = metrics.buckets.get(bound) || 0;
        lines.push(
          `routes_b_request_duration_ms_bucket{${routeLabel},le="${bound}"} ${count}`
        );
      }
      // +Inf bucket
      const infCount = metrics.buckets.get(INF_BUCKET) || 0;
      lines.push(
        `routes_b_request_duration_ms_bucket{${routeLabel},le="+Inf"} ${infCount}`
      );

      // Sum and count
      lines.push(
        `routes_b_request_duration_ms_sum{${routeLabel}} ${metrics.totalMs}`
      );
      lines.push(
        `routes_b_request_duration_ms_count{${routeLabel}} ${metrics.count}`
      );
    }

    lines.push("");
    lines.push("# HELP routes_b_request_outcome_total Request outcomes by route");
    lines.push("# TYPE routes_b_request_outcome_total counter");

    for (const metrics of snapshot.routes) {
      const routeLabel = `route="${this.escapeLabel(metrics.route)}"`;
      for (const [outcome, count] of metrics.outcomes) {
        lines.push(
          `routes_b_request_outcome_total{${routeLabel},outcome="${outcome}"} ${count}`
        );
      }
    }

    lines.push("");
    lines.push("# HELP routes_b_p50_request_duration_ms p50 latency per route");
    lines.push("# TYPE routes_b_p50_request_duration_ms gauge");

    for (const metrics of snapshot.routes) {
      const p50 = this.computePercentile(metrics, 50);
      if (p50 !== null) {
        lines.push(
          `routes_b_p50_request_duration_ms{route="${this.escapeLabel(metrics.route)}"} ${p50}`
        );
      }
    }

    lines.push("");
    lines.push("# HELP routes_b_p95_request_duration_ms p95 latency per route");
    lines.push("# TYPE routes_b_p95_request_duration_ms gauge");

    for (const metrics of snapshot.routes) {
      const p95 = this.computePercentile(metrics, 95);
      if (p95 !== null) {
        lines.push(
          `routes_b_p95_request_duration_ms{route="${this.escapeLabel(metrics.route)}"} ${p95}`
        );
      }
    }

    return lines.join("\n") + "\n";
  }

  /** Escape Prometheus label values */
  private escapeLabel(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  }

  /** Reset all metrics (useful for testing) */
  reset(): void {
    this.store.clear();
  }
}

// ── Singleton Instance 

export const metrics = new MetricsCollector();

//  Timing Wrapper 

/**
 * Wrap a handler to record timing metrics.
 * Usage:
 *   export const GET = withMetrics("GET /api/routes-b/invoices", async (req) => { ... });
 */
export function withMetrics<
  T extends (req: Request, ...args: any[]) => Promise<Response>
>(route: string, handler: T): T {
  return (async (req: Request, ...args: any[]) => {
    const start = performance.now();
    let status = 500;

    try {
      const response = await handler(req, ...args);
      status = response.status;
      return response;
    } catch (error) {
      // Re-throw but record the error status
      status = 500;
      throw error;
    } finally {
      const duration = performance.now() - start;
      metrics.record(route, duration, status);
    }
  }) as T;
}