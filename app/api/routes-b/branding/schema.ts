import { z } from 'zod'

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid 6-digit hex color')

const httpsUrl = z
  .string()
  .url('Must be a valid URL')
  .max(512, 'Must be 512 characters or fewer')
  .refine((value) => value.startsWith('https://'), 'Must use https')

const fqdn = z
  .string()
  .max(253, 'Must be 253 characters or fewer')
  .regex(
    /^(?=.{1,253}$)(?:(?!-)[A-Za-z0-9-]{1,63}(?<!-)\.)+(?:[A-Za-z]{2,63})$/,
    'Must be a valid domain name'
  )

export const brandingSchema = z
  .object({
    primaryColor: hexColor.optional(),
    secondaryColor: hexColor.optional(),
    accentColor: hexColor.optional(),
    logoUrl: httpsUrl.nullable().optional(),
    customDomain: fqdn.nullable().optional(),
    footerText: z.string().max(200, 'Must be 200 characters or fewer').nullable().optional(),
    signatureUrl: httpsUrl.nullable().optional(),
  })
  .strip()

export type BrandingPayload = z.infer<typeof brandingSchema>
