import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function isValidHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function sniffMimeType(buffer: ArrayBuffer): string | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 8) {
    const isPng =
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a;
    if (isPng) return "image/png";
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return "image/gif";
  }

  return null;
}

export async function POST(request: NextRequest) {
  const authToken = request.headers
    .get("authorization")
    ?.replace("Bearer ", "");
  const claims = await verifyAuthToken(authToken || "");
  if (!claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("avatar") as File | null;

    if (!file) {
      return NextResponse.json(
        { error: "avatar file is required" },
        { status: 400 }
      );
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File size exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit` },
        { status: 413 }
      );
    }

    // Validate MIME type from file extension
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: `Invalid MIME type. Allowed types: ${Array.from(ALLOWED_MIME_TYPES).join(", ")}` },
        { status: 415 }
      );
    }

    // Validate actual file content by sniffing MIME type
    const buffer = await file.arrayBuffer();
    const sniffedMime = sniffMimeType(buffer);
    
    if (!sniffedMime || !ALLOWED_MIME_TYPES.has(sniffedMime)) {
      return NextResponse.json(
        { error: "Invalid file content. Only JPEG, PNG, WebP, and GIF images are allowed" },
        { status: 415 }
      );
    }

    // For now, we'll store the file as base64 in the avatarUrl field
    // In production, this should upload to a cloud storage service
    const base64 = Buffer.from(buffer).toString("base64");
    const dataUrl = `data:${sniffedMime};base64,${base64}`;

    const user = await prisma.user.update({
      where: { privyId: claims.userId },
      data: { avatarUrl: dataUrl },
      select: { avatarUrl: true },
    });

    return NextResponse.json(user);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to process avatar upload" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  const authToken = request.headers
    .get("authorization")
    ?.replace("Bearer ", "");
  const claims = await verifyAuthToken(authToken || "");
  if (!claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { avatarUrl } = body;

  if (avatarUrl === undefined) {
    return NextResponse.json(
      { error: "avatarUrl is required" },
      { status: 400 }
    );
  }

  if (avatarUrl !== null) {
    if (typeof avatarUrl !== "string") {
      return NextResponse.json(
        { error: "avatarUrl must be a string or null" },
        { status: 400 }
      );
    }

    if (avatarUrl.length > 512) {
      return NextResponse.json(
        { error: "avatarUrl must not exceed 512 characters" },
        { status: 400 }
      );
    }

    if (!isValidHttpsUrl(avatarUrl)) {
      return NextResponse.json(
        { error: "avatarUrl must be a valid HTTPS URL" },
        { status: 400 }
      );
    }
  }

  const user = await prisma.user.update({
    where: { privyId: claims.userId },
    data: { avatarUrl },
    select: { avatarUrl: true },
  });

  return NextResponse.json(user);
}
