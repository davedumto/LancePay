import { describe, it, expect } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  applyCors,
  handleCorsPreFlight,
  withCors,
  type CorsOptions,
} from "../_lib/cors";

/**
 * Helper to create a NextRequest with custom headers
 */
function createRequest(
  method: string = "GET",
  origin?: string,
  headers?: Record<string, string>,
): NextRequest {
  const url = new URL("http://localhost:3000/api/test");
  const init: RequestInit = {
    method,
    headers: {
      ...headers,
      ...(origin && { origin }),
    },
  };
  return new NextRequest(url, init);
}

describe("CORS helper", () => {
  describe("applyCors", () => {
    it("adds CORS headers for allowed origin", () => {
      const req = createRequest("GET", "https://example.com");
      const res = new NextResponse("OK");
      const options: CorsOptions = {
        allowOrigins: ["https://example.com"],
      };

      const result = applyCors(req, res, options);

      expect(result.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com",
      );
      expect(result.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, OPTIONS",
      );
      expect(result.headers.get("Access-Control-Allow-Headers")).toBe(
        "Content-Type",
      );
      expect(result.headers.get("Access-Control-Max-Age")).toBe("86400");
    });

    it("rejects disallowed origin (no CORS headers)", () => {
      const req = createRequest("GET", "https://evil.com");
      const res = new NextResponse("OK");
      const options: CorsOptions = {
        allowOrigins: ["https://example.com"],
      };

      const result = applyCors(req, res, options);

      expect(result.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(result.headers.get("Access-Control-Allow-Methods")).toBeNull();
    });

    it("handles missing origin header", () => {
      const req = createRequest("GET");
      const res = new NextResponse("OK");
      const options: CorsOptions = {
        allowOrigins: ["https://example.com"],
      };

      const result = applyCors(req, res, options);

      expect(result.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("allows wildcard origin", () => {
      const req = createRequest("GET", "https://any-origin.com");
      const res = new NextResponse("OK");
      const options: CorsOptions = {
        allowOrigins: "*",
      };

      const result = applyCors(req, res, options);

      expect(result.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://any-origin.com",
      );
    });

    it("allows multiple origins", () => {
      const origins = [
        "https://example.com",
        "https://app.example.com",
        "http://localhost:3000",
      ];
      const options: CorsOptions = {
        allowOrigins: origins,
      };

      for (const origin of origins) {
        const req = createRequest("GET", origin);
        const res = new NextResponse("OK");
        const result = applyCors(req, res, options);
        expect(result.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      }
    });

    it("uses custom allow methods", () => {
      const req = createRequest("GET", "https://example.com");
      const res = new NextResponse("OK");
      const options: CorsOptions = {
        allowOrigins: ["https://example.com"],
        allowMethods: ["GET", "POST", "PUT"],
      };

      const result = applyCors(req, res, options);

      expect(result.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, POST, PUT",
      );
    });

    it("uses custom allow headers", () => {
      const req = createRequest("GET", "https://example.com");
      const res = new NextResponse("OK");
      const options: CorsOptions = {
        allowOrigins: ["https://example.com"],
        allowHeaders: ["Content-Type", "Authorization", "X-Custom-Header"],
      };

      const result = applyCors(req, res, options);

      expect(result.headers.get("Access-Control-Allow-Headers")).toBe(
        "Content-Type, Authorization, X-Custom-Header",
      );
    });

    it("preserves original response body and status", async () => {
      const req = createRequest("GET", "https://example.com");
      const res = new NextResponse(JSON.stringify({ data: "test" }), {
        status: 200,
      });
      const options: CorsOptions = {
        allowOrigins: ["https://example.com"],
      };

      const result = applyCors(req, res, options);

      expect(result.status).toBe(200);
      const body = await result.json();
      expect(body).toEqual({ data: "test" });
    });

    it("preserves original response headers", () => {
      const req = createRequest("GET", "https://example.com");
      const res = new NextResponse("OK", {
        headers: {
          "X-Custom-Header": "custom-value",
          "Content-Type": "application/json",
        },
      });
      const options: CorsOptions = {
        allowOrigins: ["https://example.com"],
      };

      const result = applyCors(req, res, options);

      expect(result.headers.get("X-Custom-Header")).toBe("custom-value");
      expect(result.headers.get("Content-Control-Allow-Origin")).not.toBe(
        "custom-value",
      );
    });

    it("does not allow credentials with wildcard", () => {
      const req = createRequest("GET", "https://example.com", {
        cookie: "session=abc123",
      });
      const res = new NextResponse("OK");
      const options: CorsOptions = {
        allowOrigins: "*",
      };

      const result = applyCors(req, res, options);

      // Should still set CORS headers but not credentials
      expect(result.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com",
      );
      expect(result.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    });
  });

  describe("handleCorsPreFlight", () => {
    it("handles OPTIONS preflight for allowed origin", () => {
      const _req = createRequest("OPTIONS", "https://example.com");
      const options: CorsOptions = {
        allowOrigins: ["https://example.com"],
      };

      const result = handleCorsPreFlight(_req, options);

      expect(result.status).toBe(204);
      expect(result.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com",
      );
      expect(result.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, OPTIONS",
      );
    });

    it("rejects OPTIONS preflight for disallowed origin", () => {
      const _req = createRequest("OPTIONS", "https://evil.com");
      const options: CorsOptions = {
        allowOrigins: ["https://example.com"],
      };

      const result = handleCorsPreFlight(_req, options);

      expect(result.status).toBe(204);
      expect(result.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("handles OPTIONS with missing origin", () => {
      const _req = createRequest("OPTIONS");
      const options: CorsOptions = {
        allowOrigins: ["https://example.com"],
      };

      const result = handleCorsPreFlight(_req, options);

      expect(result.status).toBe(204);
      expect(result.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("allows wildcard origin for OPTIONS", () => {
      const _req = createRequest("OPTIONS", "https://any-origin.com");
      const options: CorsOptions = {
        allowOrigins: "*",
      };

      const result = handleCorsPreFlight(_req, options);

      expect(result.status).toBe(204);
      expect(result.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://any-origin.com",
      );
    });

    it("uses custom methods in preflight response", () => {
      const _req = createRequest("OPTIONS", "https://example.com");
      const options: CorsOptions = {
        allowOrigins: ["https://example.com"],
        allowMethods: ["GET", "POST", "DELETE"],
      };

      const result = handleCorsPreFlight(_req, options);

      expect(result.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, POST, DELETE",
      );
    });

    it("uses custom headers in preflight response", () => {
      const _req = createRequest("OPTIONS", "https://example.com");
      const options: CorsOptions = {
        allowOrigins: ["https://example.com"],
        allowHeaders: ["Content-Type", "Authorization"],
      };

      const result = handleCorsPreFlight(_req, options);

      expect(result.headers.get("Access-Control-Allow-Headers")).toBe(
        "Content-Type, Authorization",
      );
    });

    it("sets max age for preflight caching", () => {
      const _req = createRequest("OPTIONS", "https://example.com");
      const options: CorsOptions = {
        allowOrigins: ["https://example.com"],
      };

      const result = handleCorsPreFlight(_req, options);

      expect(result.headers.get("Access-Control-Max-Age")).toBe("86400");
    });
  });

  describe("withCors middleware", () => {
    it("wraps handler and applies CORS to response", async () => {
      const handler = async (_req: NextRequest) => new NextResponse("OK");
      const wrapped = withCors(handler, {
        allowOrigins: ["https://example.com"],
      });

      const req = createRequest("GET", "https://example.com");
      const result = await wrapped(req);

      expect(result.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com",
      );
    });

    it("handles OPTIONS preflight automatically", async () => {
      const handler = async (_req: NextRequest) => new NextResponse("OK");
      const wrapped = withCors(handler, {
        allowOrigins: ["https://example.com"],
      });

      const req = createRequest("OPTIONS", "https://example.com");
      const result = await wrapped(req);

      expect(result.status).toBe(204);
      expect(result.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com",
      );
    });

    it("rejects disallowed origin in wrapped handler", async () => {
      const handler = async (_req: NextRequest) => new NextResponse("OK");
      const wrapped = withCors(handler, {
        allowOrigins: ["https://example.com"],
      });

      const req = createRequest("GET", "https://evil.com");
      const result = await wrapped(req);

      expect(result.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("allows wildcard in wrapped handler", async () => {
      const handler = async (_req: NextRequest) => new NextResponse("OK");
      const wrapped = withCors(handler, {
        allowOrigins: "*",
      });

      const req = createRequest("GET", "https://any-origin.com");
      const result = await wrapped(req);

      expect(result.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://any-origin.com",
      );
    });

    it("passes through handler arguments", async () => {
      let capturedArg: any;
      const handler = async (req: NextRequest, arg: any) => {
        capturedArg = arg;
        return new NextResponse("OK");
      };
      const wrapped = withCors(handler, {
        allowOrigins: ["https://example.com"],
      });

      const req = createRequest("GET", "https://example.com");
      const testArg = { params: { id: "123" } };
      await wrapped(req, testArg);

      expect(capturedArg).toEqual(testArg);
    });

    it("preserves handler response body", async () => {
      const handler = async (req: NextRequest) =>
        new NextResponse(JSON.stringify({ message: "success" }), {
          status: 201,
        });
      const wrapped = withCors(handler, {
        allowOrigins: ["https://example.com"],
      });

      const req = createRequest("GET", "https://example.com");
      const result = await wrapped(req);

      expect(result.status).toBe(201);
      const body = await result.json();
      expect(body).toEqual({ message: "success" });
    });

    it("uses custom CORS options in wrapped handler", async () => {
      const handler = async (req: NextRequest) => new NextResponse("OK");
      const wrapped = withCors(handler, {
        allowOrigins: ["https://example.com", "https://app.example.com"],
        allowMethods: ["GET", "POST"],
        allowHeaders: ["Content-Type", "Authorization"],
      });

      const req = createRequest("GET", "https://app.example.com");
      const result = await wrapped(req);

      expect(result.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.example.com",
      );
      expect(result.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, POST",
      );
      expect(result.headers.get("Access-Control-Allow-Headers")).toBe(
        "Content-Type, Authorization",
      );
    });
  });

  describe("real-world scenarios", () => {
    it("allows public invoice endpoint to be embedded", async () => {
      const handler = async (req: NextRequest) =>
        new NextResponse(
          JSON.stringify({ invoiceNumber: "INV-001", amount: 100 }),
        );
      const wrapped = withCors(handler, {
        allowOrigins: "*",
        allowMethods: ["GET", "OPTIONS"],
        allowHeaders: ["Content-Type"],
      });

      // Preflight from embedding site
      const preflightReq = createRequest(
        "OPTIONS",
        "https://customer-site.com",
      );
      const preflightRes = await wrapped(preflightReq);
      expect(preflightRes.status).toBe(204);
      expect(preflightRes.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://customer-site.com",
      );

      // Actual GET request
      const getReq = createRequest("GET", "https://customer-site.com");
      const getRes = await wrapped(getReq);
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://customer-site.com",
      );
      const body = await getRes.json();
      expect(body.invoiceNumber).toBe("INV-001");
    });

    it("restricts to specific origins for sensitive endpoint", async () => {
      const handler = async (req: NextRequest) => new NextResponse("OK");
      const wrapped = withCors(handler, {
        allowOrigins: ["https://app.example.com", "https://admin.example.com"],
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
      });

      // Allowed origin
      const allowedReq = createRequest("GET", "https://app.example.com");
      const allowedRes = await wrapped(allowedReq);
      expect(allowedRes.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.example.com",
      );

      // Disallowed origin
      const deniedReq = createRequest("GET", "https://evil.com");
      const deniedRes = await wrapped(deniedReq);
      expect(deniedRes.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("handles preflight and actual request flow", async () => {
      const handler = async (req: NextRequest) =>
        new NextResponse(JSON.stringify({ status: "ok" }), { status: 200 });
      const wrapped = withCors(handler, {
        allowOrigins: ["https://example.com"],
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
      });

      // Browser sends preflight
      const preflightReq = createRequest("OPTIONS", "https://example.com", {
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      });
      const preflightRes = await wrapped(preflightReq);
      expect(preflightRes.status).toBe(204);
      expect(preflightRes.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com",
      );
      expect(
        preflightRes.headers.get("Access-Control-Allow-Methods"),
      ).toContain("POST");

      // Browser sends actual request
      const actualReq = createRequest("POST", "https://example.com");
      const actualRes = await wrapped(actualReq);
      expect(actualRes.status).toBe(200);
      expect(actualRes.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com",
      );
    });
  });
});
