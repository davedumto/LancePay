import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import {
  addCollaborator,
  removeCollaborator,
  updateCollaboratorShare,
  getInvoiceCollaborators,
} from "@/lib/waterfall";

async function getAuthContext(request: NextRequest) {
  const authToken = request.headers
    .get("authorization")
    ?.replace("Bearer ", "");
  if (!authToken) return { error: "Unauthorized" as const };

  const claims = await verifyAuthToken(authToken);
  if (!claims) return { error: "Invalid token" as const };

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
  });

  if (!user) return { error: "User not found" as const };

  return { user, claims };
}

const AddCollaboratorSchema = z.object({
  invoiceId: z.string().uuid("Invalid invoice ID"),
  email: z.string().email("Invalid email"),
  sharePercentage: z
    .number()
    .positive("Share percentage must be positive")
    .max(100, "Share percentage cannot exceed 100%"),
});

const UpdateCollaboratorSchema = z.object({
  collaboratorId: z.string().uuid("Invalid collaborator ID"),
  sharePercentage: z
    .number()
    .positive("Share percentage must be positive")
    .max(100, "Share percentage cannot exceed 100%"),
});

const RemoveCollaboratorSchema = z.object({
  collaboratorId: z.string().uuid("Invalid collaborator ID"),
});

// GET: List collaborators for an invoice
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthContext(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const invoiceId = searchParams.get("invoiceId");

    if (!invoiceId) {
      return NextResponse.json(
        { error: "invoiceId is required" },
        { status: 400 },
      );
    }

    // Verify user owns the invoice
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
    });

    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    if (invoice.userId !== auth.user.id) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    const collaborators = await getInvoiceCollaborators(invoiceId);

    // Calculate totals
    const totalAllocated = collaborators.reduce(
      (sum: number, c: any) => sum + Number(c.sharePercentage),
      0,
    );
    if (totalAllocated > 100) {
      return NextResponse.json(
        {
          error:
            "Invalid collaborator allocation: total allocated share exceeds 100%",
          totalAllocatedPercentage: totalAllocated,
        },
        { status: 409 },
      );
    }

    const leadShare = 100 - totalAllocated;

    return NextResponse.json({
      success: true,
      invoiceId,
      leadSharePercentage: leadShare,
      totalAllocatedPercentage: totalAllocated,
      collaborators: collaborators.map((c: any) => ({
        id: c.id,
        subContractorId: c.subContractorId,
        email: c.subContractor.email,
        name: c.subContractor.name,
        sharePercentage: Number(c.sharePercentage),
        payoutStatus: c.payoutStatus,
        internalTxId: c.internalTxId,
        paidAt: c.paidAt?.toISOString() || null,
        createdAt: c.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("Get collaborators error:", error);
    return NextResponse.json(
      { error: "Failed to get collaborators" },
      { status: 500 },
    );
  }
}

// POST: Add a new collaborator
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const body = await request.json();
    const validation = AddCollaboratorSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: validation.error.flatten().fieldErrors,
        },
        { status: 400 },
      );
    }

    const { invoiceId, email, sharePercentage } = validation.data;

    // Verify user owns the invoice
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
    });

    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    if (invoice.userId !== auth.user.id) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    if (invoice.status === "paid") {
      return NextResponse.json(
        { error: "Cannot add collaborators to a paid invoice" },
        { status: 400 },
      );
    }

    const collaborator = await addCollaborator(
      invoiceId,
      email,
      sharePercentage,
    );

    return NextResponse.json({
      success: true,
      collaborator: {
        id: collaborator.id,
        subContractorId: collaborator.subContractorId,
        email: collaborator.subContractor.email,
        name: collaborator.subContractor.name,
        sharePercentage: Number(collaborator.sharePercentage),
        payoutStatus: collaborator.payoutStatus,
      },
    });
  } catch (error) {
    console.error("Add collaborator error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to add collaborator";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// PATCH: Update collaborator share percentage
export async function PATCH(request: NextRequest) {
  try {
    const auth = await getAuthContext(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const body = await request.json();
    const validation = UpdateCollaboratorSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: validation.error.flatten().fieldErrors,
        },
        { status: 400 },
      );
    }

    const { collaboratorId, sharePercentage } = validation.data;

    const collaborator = await updateCollaboratorShare(
      collaboratorId,
      auth.user.id,
      sharePercentage,
    );

    return NextResponse.json({
      success: true,
      collaborator: {
        id: collaborator.id,
        subContractorId: collaborator.subContractorId,
        email: collaborator.subContractor.email,
        name: collaborator.subContractor.name,
        sharePercentage: Number(collaborator.sharePercentage),
        payoutStatus: collaborator.payoutStatus,
      },
    });
  } catch (error) {
    console.error("Update collaborator error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to update collaborator";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// DELETE: Remove a collaborator
export async function DELETE(request: NextRequest) {
  try {
    const auth = await getAuthContext(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const body = await request.json();
    const validation = RemoveCollaboratorSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: validation.error.flatten().fieldErrors,
        },
        { status: 400 },
      );
    }

    const { collaboratorId } = validation.data;

    // Additional ownership check (defense-in-depth): ensure the collaborator exists
    // and the invoice belongs to the authenticated user before attempting removal.
    const existing = await prisma.invoiceCollaborator.findUnique({
      where: { id: collaboratorId },
      include: { invoice: true },
    });

    if (!existing) {
      return NextResponse.json(
        { error: "Collaborator not found" },
        { status: 404 },
      );
    }

    if (existing.invoice.userId !== auth.user.id) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    if (existing.payoutStatus === "completed") {
      return NextResponse.json(
        { error: "Cannot remove a collaborator who has already been paid" },
        { status: 400 },
      );
    }

    // Now call the shared logic which also performs checks — keep for single source of truth.
    await removeCollaborator(collaboratorId, auth.user.id);

    return NextResponse.json({
      success: true,
      message: "Collaborator removed",
    });
  } catch (error) {
    console.error("Remove collaborator error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to remove collaborator";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
