/**
 * Zod-to-OpenAPI schema converter
 *
 * Converts Zod schemas to OpenAPI 3.1 JSON Schema format.
 * Supports: object, string, number, boolean, enum, array, optional, nullable
 */

import { z } from "zod";

export interface OpenAPISchema {
  type?: string;
  properties?: Record<string, OpenAPISchema>;
  required?: string[];
  items?: OpenAPISchema;
  enum?: (string | number | boolean)[];
  default?: any;
  description?: string;
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  [key: string]: any;
}

/**
 * Convert a Zod schema to OpenAPI 3.1 JSON Schema
 */
export function zodToOpenAPI(schema: z.ZodTypeAny): OpenAPISchema {
  // Unwrap optional/nullable/default wrappers to get the base type
  const unwrapped = unwrapSchema(schema);
  const baseSchema = convertZodToOpenAPI(unwrapped);

  // Handle nullable by adding null to type
  if (isNullable(schema)) {
    if (baseSchema.type) {
      baseSchema.type = [baseSchema.type, "null"];
    }
  }

  return baseSchema;
}

/**
 * Unwrap optional, nullable, and default wrappers
 */
function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodOptional) {
    return unwrapSchema(schema._def.innerType);
  }
  if (schema instanceof z.ZodNullable) {
    return unwrapSchema(schema._def.innerType);
  }
  if (schema instanceof z.ZodDefault) {
    return unwrapSchema(schema._def.innerType);
  }
  return schema;
}

/**
 * Check if a schema is nullable
 */
function isNullable(schema: z.ZodTypeAny): boolean {
  return schema instanceof z.ZodNullable;
}

/**
 * Core conversion logic
 */
function convertZodToOpenAPI(schema: z.ZodTypeAny): OpenAPISchema {
  // String type
  if (schema instanceof z.ZodString) {
    return convertString(schema);
  }

  // Number type
  if (schema instanceof z.ZodNumber) {
    return convertNumber(schema);
  }

  // Boolean type
  if (schema instanceof z.ZodBoolean) {
    return { type: "boolean" };
  }

  // Enum type
  if (schema instanceof z.ZodEnum) {
    return convertEnum(schema);
  }

  // Native enum type
  if (schema instanceof z.ZodNativeEnum) {
    return convertNativeEnum(schema);
  }

  // Array type
  if (schema instanceof z.ZodArray) {
    return convertArray(schema);
  }

  // Object type
  if (schema instanceof z.ZodObject) {
    return convertObject(schema);
  }

  // Literal type
  if (schema instanceof z.ZodLiteral) {
    return { enum: [schema._def.value] };
  }

  // Union type - try to extract enum if all are literals
  if (schema instanceof z.ZodUnion) {
    const options = schema._def.options as z.ZodTypeAny[];
    const literals = options.filter((opt) => opt instanceof z.ZodLiteral);
    if (literals.length === options.length) {
      return {
        enum: literals.map((lit) => (lit as z.ZodLiteral<any>)._def.value),
      };
    }
  }

  // Fallback for unknown types
  return { type: "object" };
}

/**
 * Convert ZodString to OpenAPI schema
 */
function convertString(schema: z.ZodString): OpenAPISchema {
  const result: OpenAPISchema = { type: "string" };
  const checks = schema._def.checks || [];

  for (const check of checks) {
    switch (check.kind) {
      case "min":
        result.minLength = check.value;
        break;
      case "max":
        result.maxLength = check.value;
        break;
      case "regex":
        result.pattern = check.regex.source;
        break;
      case "url":
        result.format = "uri";
        break;
      case "email":
        result.format = "email";
        break;
      case "uuid":
        result.format = "uuid";
        break;
      case "datetime":
        result.format = "date-time";
        break;
      case "date":
        result.format = "date";
        break;
      case "time":
        result.format = "time";
        break;
      case "ip":
        result.format = "ipv4";
        break;
    }
  }

  return result;
}

/**
 * Convert ZodNumber to OpenAPI schema
 */
function convertNumber(schema: z.ZodNumber): OpenAPISchema {
  const result: OpenAPISchema = { type: "number" };
  const checks = schema._def.checks || [];

  for (const check of checks) {
    switch (check.kind) {
      case "min":
        if (check.inclusive) {
          result.minimum = check.value;
        } else {
          result.exclusiveMinimum = check.value;
        }
        break;
      case "max":
        if (check.inclusive) {
          result.maximum = check.value;
        } else {
          result.exclusiveMaximum = check.value;
        }
        break;
      case "int":
        result.type = "integer";
        break;
    }
  }

  return result;
}

/**
 * Convert ZodEnum to OpenAPI schema
 */
function convertEnum(schema: z.ZodEnum<any>): OpenAPISchema {
  return {
    enum: schema._def.values,
  };
}

/**
 * Convert ZodNativeEnum to OpenAPI schema
 */
function convertNativeEnum(schema: z.ZodNativeEnum<any>): OpenAPISchema {
  const values = Object.values(schema._def.values);
  return {
    enum: values,
  };
}

/**
 * Convert ZodArray to OpenAPI schema
 */
function convertArray(schema: z.ZodArray): OpenAPISchema {
  const result: OpenAPISchema = {
    type: "array",
    items: zodToOpenAPI(schema._def.type),
  };

  const checks = schema._def.checks || [];
  for (const check of checks) {
    switch (check.kind) {
      case "min":
        result.minItems = check.value;
        break;
      case "max":
        result.maxItems = check.value;
        break;
    }
  }

  return result;
}

/**
 * Convert ZodObject to OpenAPI schema
 */
function convertObject(schema: z.ZodObject<any>): OpenAPISchema {
  const shape = schema._def.shape() || {};
  const properties: Record<string, OpenAPISchema> = {};
  const required: string[] = [];

  Object.entries(shape).forEach(([key, value]) => {
    const fieldSchema = value as z.ZodTypeAny;
    properties[key] = zodToOpenAPI(fieldSchema);

    // Check if field is required (not optional, not nullable, not default)
    if (
      !(fieldSchema instanceof z.ZodOptional) &&
      !(fieldSchema instanceof z.ZodNullable) &&
      !(fieldSchema instanceof z.ZodDefault)
    ) {
      required.push(key);
    }
  });

  return {
    type: "object",
    properties,
    ...(required.length > 0 && { required }),
  };
}
