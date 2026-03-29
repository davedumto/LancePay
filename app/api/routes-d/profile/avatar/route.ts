import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";

function isValidHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
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
