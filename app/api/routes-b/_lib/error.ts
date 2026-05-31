/**
 * Error envelope helper for routes-b with Zod schema mismatch hints.
 * Backwards-compatible: existing `fields` array remains, new `fieldHints` map added.
 */

import { z } from 'zod';

// Types 

export interface FieldHint {
  /** The expected Zod schema type (e.g., "string", "number", "email", "enum['pending','paid']") */
  expected: string;
  /** What was actually received (e.g., "undefined", "number", "object") */
  received: string;
  /** Human-readable path to the field */
  path: string;
}

export interface ErrorEnvelope {
  /** Error code for programmatic handling */
  code: string;
  /** Human-readable message */
  message: string;
  /** Legacy field list (backwards compatible) */
  fields?: string[];
  /** New: per-field schema mismatch hints */
  fieldHints?: Record<string, FieldHint>;
  /** Request ID for tracing */
  requestId?: string;
}

// Zod Issue Walker 

/**
 * Walk a Zod issue tree and extract field hints.
 * Handles nested objects, arrays, unions, and deep paths.
 */
export function extractFieldHintsFromZodError(error: z.ZodError): Record<string, FieldHint> {
  const hints: Record<string, FieldHint> = {};

  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'root';
    
    // Skip if we already have a hint for this path (first issue wins)
    if (hints[path]) continue;

    const expected = inferExpectedType(issue);
    const received = inferReceivedType(issue);

    hints[path] = {
      expected,
      received,
      path,
    };
  }

  return hints;
}

/**
 * Infer the expected type from a Zod issue.
 */
function inferExpectedType(issue: z.ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return formatZodType(issue.expected);
    case 'invalid_string':
      if (issue.validation === 'email') return 'string (email format)';
      if (issue.validation === 'url') return 'string (URL format)';
      if (issue.validation === 'uuid') return 'string (UUID format)';
      if (issue.validation === 'regex') return `string (matching ${issue.message})`;
      return 'string';
    case 'too_small':
      if (issue.type === 'string') return `string (min ${issue.minimum} chars)`;
      if (issue.type === 'number') return `number (min ${issue.minimum})`;
      if (issue.type === 'array') return `array (min ${issue.minimum} items)`;
      return `${issue.type} (min ${issue.minimum})`;
    case 'too_big':
      if (issue.type === 'string') return `string (max ${issue.maximum} chars)`;
      if (issue.type === 'number') return `number (max ${issue.maximum})`;
      if (issue.type === 'array') return `array (max ${issue.maximum} items)`;
      return `${issue.type} (max ${issue.maximum})`;
    case 'invalid_enum_value':
      return `enum[${issue.options.join(', ')}]`;
    case 'invalid_date':
      return 'date';
    case 'invalid_literal':
      return `literal(${JSON.stringify(issue.expected)})`;
    case 'unrecognized_keys':
      return `object (unknown keys: ${issue.keys.join(', ')})`;
    case 'invalid_union':
      return 'union (none of the options matched)';
    case 'invalid_arguments':
      return 'function arguments';
    case 'invalid_return_type':
      return 'function return type';
    case 'custom':
      return issue.message || 'custom validation';
    default:
      return issue.message || 'unknown';
  }
}

/**
 * Format a Zod type name to be human-readable.
 */
function formatZodType(type: string): string {
  const typeMap: Record<string, string> = {
    'string': 'string',
    'number': 'number',
    'boolean': 'boolean',
    'bigint': 'bigint',
    'date': 'date',
    'undefined': 'undefined',
    'null': 'null',
    'array': 'array',
    'object': 'object',
    'function': 'function',
    'symbol': 'symbol',
    'nan': 'NaN',
    'integer': 'integer',
    'float': 'float',
    'any': 'any',
    'unknown': 'unknown',
    'never': 'never',
    'void': 'void',
  };

  return typeMap[type] || type;
}

/**
 * Infer what was actually received from a Zod issue.
 */
function inferReceivedType(issue: z.ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return formatZodType(issue.received);
    case 'invalid_string':
      return 'string (invalid format)';
    case 'too_small':
    case 'too_big':
      // The type was correct but the value was out of bounds
      return `${issue.type} (value out of bounds)`;
    case 'invalid_enum_value':
      return `string (received: "${issue.received}")`;
    case 'unrecognized_keys':
      return `object (extra keys present)`;
    case 'invalid_union':
      return 'mixed (no union option matched)';
    default:
      return 'unknown';
  }
}

//  Error Envelope Builder 

/**
 * Build an error envelope from a Zod validation failure.
 * Populates fieldHints by walking the Zod issue tree.
 */
export function buildZodErrorEnvelope(
  zodError: z.ZodError,
  options?: {
    code?: string;
    message?: string;
    requestId?: string;
  }
): ErrorEnvelope {
  const fieldHints = extractFieldHintsFromZodError(zodError);
  const fields = Object.keys(fieldHints);

  return {
    code: options?.code || 'VALIDATION_ERROR',
    message: options?.message || 'Request body validation failed',
    fields: fields.length > 0 ? fields : undefined,
    fieldHints: fields.length > 0 ? fieldHints : undefined,
    requestId: options?.requestId,
  };
}

/**
 * Build a generic error envelope (non-Zod source).
 * Maintains backwards compatibility — no fieldHints.
 */
export function buildErrorEnvelope(
  code: string,
  message: string,
  options?: {
    fields?: string[];
    requestId?: string;
  }
): ErrorEnvelope {
  return {
    code,
    message,
    fields: options?.fields,
    requestId: options?.requestId,
  };
}

//  Response Helpers 

/**
 * Create a NextResponse with a Zod error envelope.
 */
export function zodErrorResponse(
  zodError: z.ZodError,
  status: number = 400,
  options?: {
    code?: string;
    message?: string;
    requestId?: string;
  }
): Response {
  const envelope = buildZodErrorEnvelope(zodError, options);
  
  return new Response(JSON.stringify(envelope), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Create a NextResponse with a generic error envelope.
 */
export function errorResponse(
  code: string,
  message: string,
  status: number = 400,
  options?: {
    fields?: string[];
    requestId?: string;
  }
): Response {
  const envelope = buildErrorEnvelope(code, message, options);
  
  return new Response(JSON.stringify(envelope), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}