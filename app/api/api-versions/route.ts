import { NextResponse, type NextRequest } from "next/server";

export interface ApiVersionInfo {
  version: string;
  status: "active" | "deprecated" | "sunset";
  releaseDate: string;
  sunsetDate: string | null;
  changelogUrl: string;
}

export interface ApiVersionsResponse {
  defaultVersion: string;
  versions: ApiVersionInfo[];
}

export const API_VERSIONS: ApiVersionInfo[] = [
  {
    version: "2026-04-01",
    status: "active",
    releaseDate: "2026-04-01",
    sunsetDate: null,
    changelogUrl: "https://docs.lancepay.xyz/changelog/2026-04-01",
  },
  {
    version: "2025-10-01",
    status: "deprecated",
    releaseDate: "2025-10-01",
    sunsetDate: "2026-10-01",
    changelogUrl: "https://docs.lancepay.xyz/changelog/2025-10-01",
  },
  {
    version: "2025-01-01",
    status: "sunset",
    releaseDate: "2025-01-01",
    sunsetDate: "2025-12-31",
    changelogUrl: "https://docs.lancepay.xyz/changelog/2025-01-01",
  },
];

export const DEFAULT_API_VERSION = "2026-04-01";

export async function GET(_request: NextRequest) {
  try {
    const responseData: ApiVersionsResponse = {
      defaultVersion: DEFAULT_API_VERSION,
      versions: API_VERSIONS,
    };

    return NextResponse.json(responseData, {
      status: 200,
      headers: {
        "Cache-Control":
          "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
        Vary: "Accept-Encoding",
      },
    });
  } catch (_error) {
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
