/**
 * Virtual Account Management API
 *
 * GET  /api/routes-d/virtual-accounts/manage - Fetch user's virtual account
 * POST /api/routes-d/virtual-accounts/manage - Create virtual account for user
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyAuthToken } from "@/lib/auth";
import {
  createVirtualAccount,
  getVirtualAccountByUserId,
} from "@/lib/virtual-accounts/service";
import {
  AccountExistsError,
  ProviderError,
} from "@/lib/virtual-accounts/provider-interface";

/**
 * GET /api/routes-d/virtual-accounts/manage
 * Fetch the authenticated user's virtual account details
 */
export async function GET(request: NextRequest) {
  try {
    // Authenticate user
    const authToken = request.headers
      .get("authorization")
      ?.replace("Bearer ", "");
    const claims = await verifyAuthToken(authToken || "");

    if (!claims) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Find user by Privy ID
    const { prisma } = await import("@/lib/db");
    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Fetch virtual account
    const virtualAccount = await getVirtualAccountByUserId(user.id);

    if (!virtualAccount) {
      return NextResponse.json(
        {
          exists: false,
          message: "No virtual account found. Create one using POST request.",
        },
        { status: 404 },
      );
    }

    // Mask account number for security (show last 4 digits)
    const maskedAccountNumber = virtualAccount.accountNumber.replace(
      /(\d{6})(\d{4})/,
      "******$2",
    );

    return NextResponse.json({
      exists: true,
      virtualAccount: {
        bankName: virtualAccount.bankName,
        accountNumber: virtualAccount.accountNumber, // Full number for user's convenience
        accountNumberMasked: maskedAccountNumber,
        accountName: virtualAccount.accountName,
        provider: virtualAccount.provider,
        status: virtualAccount.status,
        createdAt: virtualAccount.createdAt,
      },
    });
  } catch (error) {
    console.error("GET virtual account error:", error);
    return NextResponse.json(
      { error: "Failed to fetch virtual account" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/routes-d/virtual-accounts/manage
 * Create a new virtual account for the authenticated user
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const authToken = request.headers
      .get("authorization")
      ?.replace("Bearer ", "");
    const claims = await verifyAuthToken(authToken || "");

    if (!claims) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Find user by Privy ID
    const { prisma } = await import("@/lib/db");
    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, email: true, name: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Create virtual account
    const virtualAccount = await createVirtualAccount(user.id);

    console.log("Virtual account created:", {
      userId: user.id,
      accountNumber: virtualAccount.accountNumber,
      provider: virtualAccount.provider,
    });

    return NextResponse.json(
      {
        success: true,
        message: "Virtual account created successfully",
        virtualAccount: {
          bankName: virtualAccount.bankName,
          accountNumber: virtualAccount.accountNumber,
          accountName: virtualAccount.accountName,
          provider: virtualAccount.provider,
          status: virtualAccount.status,
          createdAt: virtualAccount.createdAt,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("POST virtual account error:", error);

    // Handle duplicate account error
    if (error instanceof AccountExistsError) {
      return NextResponse.json(
        {
          error: "Virtual account already exists",
          message:
            "You already have a virtual account. Use GET request to fetch details.",
          accountNumber: error.accountNumber,
        },
        { status: 409 },
      );
    }

    // Handle provider errors
    if (error instanceof ProviderError) {
      return NextResponse.json(
        {
          error: "Provider error",
          message: error.message,
          provider: error.provider,
        },
        { status: error.statusCode || 500 },
      );
    }

    // Generic error
    return NextResponse.json(
      {
        error: "Failed to create virtual account",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
