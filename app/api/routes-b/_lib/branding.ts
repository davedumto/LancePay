import { prisma } from '@/lib/db';

export const DEFAULT_BRANDING = {
  logoUrl: null,
  primaryColor: '#3b82f6',
  secondaryColor: '#64748b',
  accentColor: '#8b5cf6',
  companyName: null,
  tagline: null,
  websiteUrl: null,
  // Add any other branding fields your schema has
} as const;

export type BrandingData = typeof DEFAULT_BRANDING;

/**
 * Returns the current branding for a user
 */
export async function getCurrentBranding(userId: string) {
  return prisma.branding.findUnique({
    where: { userId },
  });
}

/**
 * Reverts branding to defaults atomically and returns previous values for audit
 */
export async function revertBrandingToDefaults(userId: string) {
  return prisma.$transaction(async (tx) => {
    // Get current branding before reverting (for audit)
    const current = await tx.branding.findUnique({
      where: { userId },
    });

    const previousValues = current
      ? {
          logoUrl: current.logoUrl,
          primaryColor: current.primaryColor,
          secondaryColor: current.secondaryColor,
          accentColor: current.accentColor,
          companyName: current.companyName,
          tagline: current.tagline,
          websiteUrl: current.websiteUrl,
        }
      : null;

    // Upsert to defaults (handles both create and update cases)
    const updated = await tx.branding.upsert({
      where: { userId },
      update: { ...DEFAULT_BRANDING },
      create: {
        userId,
        ...DEFAULT_BRANDING,
      },
    });

    return {
      previous: previousValues,
      current: updated,
    };
  });
}