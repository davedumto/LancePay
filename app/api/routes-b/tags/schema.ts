import { z } from 'zod';
import { TAG_LIMITS } from '../_lib/limits';

const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;

export const createTagSchema = z.object({
  name: z
    .string()
    .transform((val) => val.trim())
    .refine((val) => val.length > 0, 'Tag name cannot be empty')
    .refine(
      (val) => val.length <= TAG_LIMITS.MAX_TAG_NAME_LENGTH,
      `Tag name cannot be longer than ${TAG_LIMITS.MAX_TAG_NAME_LENGTH} characters`
    )
    .transform((val) => val.toLowerCase()),

  color: z
    .string()
    .regex(HEX_COLOR_REGEX, 'Color must be a valid 6-character hex code (e.g. #FF0000)'),
});

export type CreateTagInput = z.infer<typeof createTagSchema>;