import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { logger } from "@/lib/logger";

type PriceListDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

function getPriceListDelegate(): PriceListDelegate {
  return (prisma as unknown as { priceList: PriceListDelegate }).priceList;
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get("authorization")?.replace("Bearer ", "");
  const claims = await verifyAuthToken(authToken || "");
  if (!claims) return null;
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  });
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "20", 10) || 20));

    const priceLists = await getPriceListDelegate().findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        name: true,
        description: true,
        currency: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({ priceLists, page, limit });
  } catch (error) {
    logger.error({ err: error }, "GET /api/routes-b/price-lists error");
    return NextResponse.json({ error: "Failed to list price lists" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const b = body as Record<string, unknown>;

    const name = typeof b?.name === "string" ? b.name.trim() : "";
    if (!name || name.length > 255) {
      return NextResponse.json(
        { error: "name is required and must be at most 255 characters" },
        { status: 400 },
      );
    }

    const description =
      b?.description === undefined || b?.description === null
        ? null
        : typeof b.description === "string"
          ? b.description.trim() || null
          : undefined;

    if (description === undefined) {
      return NextResponse.json({ error: "description must be a string" }, { status: 400 });
    }

    const currency =
      typeof b?.currency === "string" ? b.currency.trim().toUpperCase() : "USD";
    if (!currency || currency.length !== 3) {
      return NextResponse.json(
        { error: "currency must be a valid 3-letter ISO code (e.g. USD)" },
        { status: 400 },
      );
    }

    const isDefault = b?.isDefault === true;

    const priceList = await getPriceListDelegate().create({
      data: {
        userId: user.id,
        name,
        description,
        currency,
        isDefault,
      },
      select: {
        id: true,
        name: true,
        description: true,
        currency: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({ priceList }, { status: 201 });
  } catch (error) {
    logger.error({ err: error }, "POST /api/routes-b/price-lists error");
    return NextResponse.json({ error: "Failed to create price list" }, { status: 500 });
  }
}
