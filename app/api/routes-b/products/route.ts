import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { logger } from "@/lib/logger";

type ProductDelegate = {
  findMany: (
    args: Record<string, unknown>,
  ) => Promise<Array<Record<string, unknown>>>;
  create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

function getProductDelegate(): ProductDelegate {
  return (prisma as unknown as { product: ProductDelegate }).product;
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers
    .get("authorization")
    ?.replace("Bearer ", "");
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
    const activeParam = searchParams.get("active");

    if (
      activeParam !== null &&
      activeParam !== "true" &&
      activeParam !== "false"
    ) {
      return NextResponse.json(
        { error: "active must be true or false" },
        { status: 400 },
      );
    }

    const products = await getProductDelegate().findMany({
      where: {
        userId: user.id,
        ...(activeParam !== null ? { isActive: activeParam === "true" } : {}),
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        description: true,
        priceUsdc: true,
        unit: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        priceUsdc: p.priceUsdc.toString(),
        unit: p.unit,
        isActive: p.isActive,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
    });
  } catch (error) {
    logger.error({ err: error }, "GET /api/routes-b/products error");
    return NextResponse.json(
      { error: "Failed to list products" },
      { status: 500 },
    );
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
      return NextResponse.json(
        { error: "description must be a string" },
        { status: 400 },
      );
    }

    const priceUsdc = b?.priceUsdc;
    const priceNum =
      typeof priceUsdc === "number" ? priceUsdc : parseFloat(String(priceUsdc));
    if (isNaN(priceNum) || priceNum < 0) {
      return NextResponse.json(
        { error: "priceUsdc is required and must be a non-negative number" },
        { status: 400 },
      );
    }

    const unit =
      b?.unit === undefined || b?.unit === null
        ? "item"
        : typeof b.unit === "string"
          ? b.unit.trim() || "item"
          : "item";

    if (typeof unit !== "string" || unit.length > 50) {
      return NextResponse.json(
        { error: "unit must be at most 50 characters" },
        { status: 400 },
      );
    }

    const product = await getProductDelegate().create({
      data: {
        userId: user.id,
        name,
        description,
        priceUsdc: priceNum,
        unit,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        description: true,
        priceUsdc: true,
        unit: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json(
      {
        product: {
          id: product.id,
          name: product.name,
          description: product.description ?? null,
          priceUsdc: product.priceUsdc.toString(),
          unit: product.unit,
          isActive: product.isActive,
          createdAt: product.createdAt,
          updatedAt: product.updatedAt,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    logger.error({ err: error }, "POST /api/routes-b/products error");
    return NextResponse.json(
      { error: "Failed to create product" },
      { status: 500 },
    );
  }
}
