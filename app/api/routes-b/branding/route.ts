import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { registerRoute } from '../_lib/openapi'
import { z } from 'zod'

// Register OpenAPI documentation
registerRoute({
  method: 'PATCH',
  path: '/branding',
  summary: 'Update branding settings',
  description: 'Update logo, colors, footer text, or signature for invoice branding.',
  requestSchema: z.object({
    logoUrl: z.string().url().optional(),
    primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    footerText: z.string().max(200).optional(),
    signatureUrl: z.string().url().optional()
  }),
  responseSchema: z.object({
    branding: z.object({
      id: z.string(),
      userId: z.string(),
      logoUrl: z.string().nullable(),
      primaryColor: z.string().nullable(),
      footerText: z.string().nullable(),
      signatureUrl: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string()
    })
  }),
  tags: ['branding']
})

function isValidHexColor(color: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(color);
}

function isValidHttpsUrl(url: string): boolean {
  return url.startsWith("https://");
}

export async function PATCH(request: NextRequest) {
  const authToken = request.headers
    .get("authorization")
    ?.replace("Bearer ", "");
  if (!authToken)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const claims = await verifyAuthToken(authToken);
  if (!claims)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
  });
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { logoUrl, primaryColor, footerText, signatureUrl } = body;

  // Validate provided fields
  if (logoUrl !== undefined && logoUrl !== null) {
    if (
      typeof logoUrl !== "string" ||
      !isValidHttpsUrl(logoUrl) ||
      logoUrl.length > 512
    )
      return NextResponse.json({ error: "Invalid logoUrl" }, { status: 400 });
  }

  if (primaryColor !== undefined) {
    if (typeof primaryColor !== "string" || !isValidHexColor(primaryColor))
      return NextResponse.json(
        { error: "Invalid primaryColor" },
        { status: 400 },
      );
  }

  if (footerText !== undefined && footerText !== null) {
    if (typeof footerText !== "string" || footerText.length > 200)
      return NextResponse.json(
        { error: "footerText exceeds 200 characters" },
        { status: 400 },
      );
  }

  if (signatureUrl !== undefined && signatureUrl !== null) {
    if (
      typeof signatureUrl !== "string" ||
      !isValidHttpsUrl(signatureUrl) ||
      signatureUrl.length > 512
    )
      return NextResponse.json(
        { error: "Invalid signatureUrl" },
        { status: 400 },
      );
  }

  // Build only the fields that were provided
  const fields: Record<string, unknown> = {};
  if (logoUrl !== undefined) fields.logoUrl = logoUrl;
  if (primaryColor !== undefined) fields.primaryColor = primaryColor;
  if (footerText !== undefined) fields.footerText = footerText;
  if (signatureUrl !== undefined) fields.signatureUrl = signatureUrl;

  const branding = await prisma.brandingSettings.upsert({
    where: { userId: user.id },
    update: fields,
    create: { userId: user.id, ...fields },
  });

  return NextResponse.json({ branding });
}