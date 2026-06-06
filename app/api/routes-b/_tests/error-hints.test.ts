import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  extractFieldHintsFromZodError,
  buildZodErrorEnvelope,
  buildErrorEnvelope,
} from '../_lib/error';

describe('Field Hints from Zod Errors', () => {
  // Missing Field 

  it('hints for missing required field', () => {
    const schema = z.object({
      email: z.string().email(),
      name: z.string().min(1),
    });

    const result = schema.safeParse({ name: 'John' });
    expect(result.success).toBe(false);

    if (!result.success) {
      const hints = extractFieldHintsFromZodError(result.error);
      
      expect(hints['email']).toEqual({
        expected: 'string (email format)',
        received: 'undefined',
        path: 'email',
      });
    }
  });

  // Wrong Type

  it('hints for wrong primitive type', () => {
    const schema = z.object({
      age: z.number().positive(),
      name: z.string(),
    });

    const result = schema.safeParse({ age: 'twenty-five', name: 'John' });
    expect(result.success).toBe(false);

    if (!result.success) {
      const hints = extractFieldHintsFromZodError(result.error);
      
      expect(hints['age']).toEqual({
        expected: 'number',
        received: 'string',
        path: 'age',
      });
    }
  });

  it('hints for wrong type on number field', () => {
    const schema = z.object({
      amount: z.number().positive(),
    });

    const result = schema.safeParse({ amount: true });
    expect(result.success).toBe(false);

    if (!result.success) {
      const hints = extractFieldHintsFromZodError(result.error);
      expect(hints['amount'].expected).toBe('number');
      expect(hints['amount'].received).toBe('boolean');
    }
  });

  // Extra Unknown Key 

  it('hints for extra unknown keys', () => {
    const schema = z.object({
      email: z.string().email(),
    }).strict();

    const result = schema.safeParse({ email: 'test@example.com', extraField: 'value' });
    expect(result.success).toBe(false);

    if (!result.success) {
      const hints = extractFieldHintsFromZodError(result.error);
      
      expect(hints['root']).toEqual({
        expected: "object (unknown keys: extraField)",
        received: 'object (extra keys present)',
        path: 'root',
      });
    }
  });

  // Nested Object Errors 

  it('hints for nested object field errors', () => {
    const schema = z.object({
      user: z.object({
        profile: z.object({
          age: z.number().int().min(0),
          name: z.string().min(2),
        }),
      }),
    });

    const result = schema.safeParse({
      user: {
        profile: {
          age: -5,
          name: 'A',
        },
      },
    });
    expect(result.success).toBe(false);

    if (!result.success) {
      const hints = extractFieldHintsFromZodError(result.error);
      
      expect(hints['user.profile.age']).toBeDefined();
      expect(hints['user.profile.age'].expected).toContain('number');
      expect(hints['user.profile.age'].received).toContain('out of bounds');

      expect(hints['user.profile.name']).toBeDefined();
      expect(hints['user.profile.name'].expected).toContain('string');
    }
  });

  it('hints for deeply nested array errors', () => {
    const schema = z.object({
      items: z.array(z.object({
        price: z.number().positive(),
        name: z.string().min(1),
      })),
    });

    const result = schema.safeParse({
      items: [
        { price: 10, name: 'Valid' },
        { price: 'free', name: '' },
      ],
    });
    expect(result.success).toBe(false);

    if (!result.success) {
      const hints = extractFieldHintsFromZodError(result.error);
      
      // Should have hints for the invalid array item
      const paths = Object.keys(hints);
      expect(paths.some(p => p.includes('items'))).toBe(true);
    }
  });

  // Enum Mismatch 

  it('hints for invalid enum value', () => {
    const schema = z.object({
      status: z.enum(['pending', 'paid', 'overdue']),
    });

    const result = schema.safeParse({ status: 'draft' });
    expect(result.success).toBe(false);

    if (!result.success) {
      const hints = extractFieldHintsFromZodError(result.error);
      
      expect(hints['status']).toEqual({
        expected: "enum[pending, paid, overdue]",
        received: 'string (received: "draft")',
        path: 'status',
      });
    }
  });

  // String Format Errors 

  it('hints for invalid email format', () => {
    const schema = z.object({
      email: z.string().email(),
    });

    const result = schema.safeParse({ email: 'not-an-email' });
    expect(result.success).toBe(false);

    if (!result.success) {
      const hints = extractFieldHintsFromZodError(result.error);
      
      expect(hints['email'].expected).toBe('string (email format)');
      expect(hints['email'].received).toBe('string (invalid format)');
    }
  });

  it('hints for invalid URL format', () => {
    const schema = z.object({
      website: z.string().url(),
    });

    const result = schema.safeParse({ website: 'not-a-url' });
    expect(result.success).toBe(false);

    if (!result.success) {
      const hints = extractFieldHintsFromZodError(result.error);
      
      expect(hints['website'].expected).toBe('string (URL format)');
    }
  });

  // Min/Max Constraint Errors 

  it('hints for string too short', () => {
    const schema = z.object({
      password: z.string().min(8),
    });

    const result = schema.safeParse({ password: 'short' });
    expect(result.success).toBe(false);

    if (!result.success) {
      const hints = extractFieldHintsFromZodError(result.error);
      
      expect(hints['password'].expected).toBe('string (min 8 chars)');
    }
  });

  it('hints for number too small', () => {
    const schema = z.object({
      quantity: z.number().int().min(1),
    });

    const result = schema.safeParse({ quantity: 0 });
    expect(result.success).toBe(false);

    if (!result.success) {
      const hints = extractFieldHintsFromZodError(result.error);
      
      expect(hints['quantity'].expected).toBe('number (min 1)');
    }
  });

  // Backwards Compatibility 

  it('buildZodErrorEnvelope includes both fields and fieldHints', () => {
    const schema = z.object({
      email: z.string().email(),
      age: z.number().positive(),
    });

    const result = schema.safeParse({ age: 'not-a-number' });
    expect(result.success).toBe(false);

    if (!result.success) {
      const envelope = buildZodErrorEnvelope(result.error);
      
      // Legacy fields array present
      expect(envelope.fields).toBeDefined();
      expect(envelope.fields).toContain('email');
      expect(envelope.fields).toContain('age');
      
      // New fieldHints map present
      expect(envelope.fieldHints).toBeDefined();
      expect(envelope.fieldHints?.['email']).toBeDefined();
      expect(envelope.fieldHints?.['age']).toBeDefined();
      
      // Both contain expected/received
      expect(envelope.fieldHints?.['age'].expected).toBe('number');
      expect(envelope.fieldHints?.['age'].received).toBe('string');
    }
  });

  it('buildErrorEnvelope has no fieldHints for non-Zod errors', () => {
    const envelope = buildErrorEnvelope('NOT_FOUND', 'Resource not found');
    
    expect(envelope.code).toBe('NOT_FOUND');
    expect(envelope.message).toBe('Resource not found');
    expect(envelope.fields).toBeUndefined();
    expect(envelope.fieldHints).toBeUndefined();
  });

  // Edge Cases 

  it('handles empty object', () => {
    const schema = z.object({
      required: z.string(),
    });

    const result = schema.safeParse({});
    expect(result.success).toBe(false);

    if (!result.success) {
      const hints = extractFieldHintsFromZodError(result.error);
      expect(hints['required'].received).toBe('undefined');
    }
  });

  it('handles null body', () => {
    const schema = z.object({
      field: z.string(),
    });

    const result = schema.safeParse(null);
    expect(result.success).toBe(false);

    if (!result.success) {
      const hints = extractFieldHintsFromZodError(result.error);
      expect(hints['root'].expected).toBe('object');
      expect(hints['root'].received).toBe('null');
    }
  });

  it('handles array where object expected', () => {
    const schema = z.object({
      data: z.object({}),
    });

    const result = schema.safeParse({ data: [] });
    expect(result.success).toBe(false);

    if (!result.success) {
      const hints = extractFieldHintsFromZodError(result.error);
      expect(hints['data'].expected).toBe('object');
      expect(hints['data'].received).toBe('array');
    }
  });

  it('handles union type failures', () => {
    const schema = z.object({
      value: z.union([z.string(), z.number()]),
    });

    const result = schema.safeParse({ value: true });
    expect(result.success).toBe(false);

    if (!result.success) {
      const hints = extractFieldHintsFromZodError(result.error);
      expect(hints['value'].expected).toBe('union (none of the options matched)');
    }
  });

  it('handles multiple errors on same field (first wins)', () => {
    const schema = z.object({
      email: z.string().email().min(5),
    });

    // This triggers both invalid_string and too_small
    const result = schema.safeParse({ email: 'a' });
    expect(result.success).toBe(false);

    if (!result.success) {
      const hints = extractFieldHintsFromZodError(result.error);
      // Should only have one hint for 'email'
      const emailHints = Object.values(hints).filter(h => h.path === 'email');
      expect(emailHints.length).toBe(1);
    }
  });
});