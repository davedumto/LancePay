import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { logger } from "@/lib/logger";

type ProductDelegate = {
  findFirst: (
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
  update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

function getProductDelegate(): ProductDelegate {
  return (prisma as unknown as { product: ProductDelegate }).product;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers
      .get("authorization")
      ?.replace("Bearer ", "");
    if (!authToken)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const claims = await verifyAuthToken(authToken);
    if (!claims)
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    });
    if (!user)
      return NextResponse.json({ error: "User not found" }, { status: 404 });

    const { id } = await params;
    if (!id)
      return NextResponse.json({ error: "id is required" }, { status: 400 });

    // Check product exists and belongs to user
    const product = await getProductDelegate().findFirst({
      where: { id, userId: user.id },
      select: { id: true, userId: true },
    });

    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const b = body as Record<string, unknown>;
    const updateData: Record<string, unknown> = {};

    // Validate and add name if provided
    if (b?.name !== undefined) {
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!name || name.length > 255) {
        return NextResponse.json(
          {
            error: "name must be a non-empty string and at most 255 characters",
          },
          { status: 400 },
        );
      }
      updateData.name = name;
    }

    // Validate and add description if provided
    if (b?.description !== undefined) {
      const description =
        b.description === null
          ? null
          : typeof b.description === "string"
            ? b.description.trim() || null
            : undefined;

      if (description === undefined) {
        return NextResponse.json(
          { error: "description must be a string or null" },
          { status: 400 },
        );
      }
      updateData.description = description;
    }

    // Validate and add priceUsdc if provided
    if (b?.priceUsdc !== undefined) {
      const priceNum =
        typeof b.priceUsdc === "number"
          ? b.priceUsdc
          : parseFloat(String(b.priceUsdc));
      if (isNaN(priceNum) || priceNum < 0) {
        return NextResponse.json(
          { error: "priceUsdc must be a non-negative number" },
          { status: 400 },
        );
      }
      updateData.priceUsdc = priceNum;
    }

    // Validate and add unit if provided
    if (b?.unit !== undefined) {
      const unit =
        b.unit === null
          ? "item"
          : typeof b.unit === "string"
            ? b.unit.trim() || "item"
            : undefined;

      if (typeof unit !== "string" || unit.length > 50) {
        return NextResponse.json(
          { error: "unit must be at most 50 characters" },
          { status: 400 },
        );
      }
      updateData.unit = unit;
    }

    // Validate and add isActive if provided
    if (b?.isActive !== undefined) {
      if (typeof b.isActive !== "boolean") {
        return NextResponse.json(
          { error: "isActive must be a boolean" },
          { status: 400 },
        );
      }
      updateData.isActive = b.isActive;
    }

    // If no fields to update, return error
    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        { error: "No fields to update" },
        { status: 400 },
      );
    }

    const updated = await getProductDelegate().update({
      where: { id },
      data: updateData,
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
      product: {
        id: updated.id,
        name: updated.name,
        description: updated.description ?? null,
        priceUsdc: (
          updated.priceUsdc as unknown as { toString: () => string }
        ).toString(),
        unit: updated.unit,
        isActive: updated.isActive,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      },
    });
  } catch (error) {
    logger.error({ err: error }, "PATCH /api/routes-b/products/[id] error");
    return NextResponse.json(
      { error: "Failed to update product" },
      { status: 500 },
    );
  }
}
