import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import {
  GET,
  DEFAULT_API_VERSION,
  API_VERSIONS,
} from "@/app/api/api-versions/route";

const URL = "http://localhost/api/api-versions";

describe("GET /api/api-versions (#1573)", () => {
  it("returns 200 with supported API versions and edge caching headers", async () => {
    const req = new NextRequest(URL, { method: "GET" });
    const res = await GET(req);

    expect(res.status).toBe(200);

    const cacheControl = res.headers.get("cache-control");
    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain("max-age=300");
    expect(cacheControl).toContain("s-maxage=300");

    const body = await res.json();
    expect(body.defaultVersion).toBe(DEFAULT_API_VERSION);
    expect(body.versions).toHaveLength(API_VERSIONS.length);

    for (const v of body.versions) {
      expect(v).toHaveProperty("version");
      expect(v).toHaveProperty("status");
      expect(["active", "deprecated", "sunset"]).toContain(v.status);
      expect(v).toHaveProperty("releaseDate");
      expect(v).toHaveProperty("sunsetDate");
      expect(v).toHaveProperty("changelogUrl");
      expect(v.changelogUrl).toMatch(/^https:\/\//);
    }
  });

  it("exposes the default version separately from the list", async () => {
    const req = new NextRequest(URL, { method: "GET" });
    const res = await GET(req);
    const body = await res.json();

    expect(body.defaultVersion).toBeDefined();
    const defaultEntry = body.versions.find(
      (v: { version: string }) => v.version === body.defaultVersion,
    );
    expect(defaultEntry).toBeDefined();
    expect(defaultEntry?.status).toBe("active");
  });

  it("includes sunset dates for deprecated and sunset versions", async () => {
    const req = new NextRequest(URL, { method: "GET" });
    const res = await GET(req);
    const body = await res.json();

    const deprecated = body.versions.find(
      (v: { status: string }) => v.status === "deprecated",
    );
    expect(deprecated).toBeDefined();
    expect(deprecated?.sunsetDate).toBeTruthy();

    const sunset = body.versions.find(
      (v: { status: string }) => v.status === "sunset",
    );
    expect(sunset).toBeDefined();
    expect(sunset?.sunsetDate).toBeTruthy();
  });
});
