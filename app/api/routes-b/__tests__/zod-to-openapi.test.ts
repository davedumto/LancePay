import { describe, it, expect } from "vitest";
import { zodToOpenAPI } from "../_lib/zod-to-openapi";
import { z } from "zod";

describe("zodToOpenAPI", () => {
  describe("primitive types", () => {
    it("converts string to OpenAPI schema", () => {
      const schema = z.string();
      const result = zodToOpenAPI(schema);
      expect(result).toEqual({ type: "string" });
    });

    it("converts number to OpenAPI schema", () => {
      const schema = z.number();
      const result = zodToOpenAPI(schema);
      expect(result).toEqual({ type: "number" });
    });

    it("converts boolean to OpenAPI schema", () => {
      const schema = z.boolean();
      const result = zodToOpenAPI(schema);
      expect(result).toEqual({ type: "boolean" });
    });
  });

  describe("string constraints", () => {
    it("handles min length constraint", () => {
      const schema = z.string().min(5);
      const result = zodToOpenAPI(schema);
      expect(result.minLength).toBe(5);
    });

    it("handles max length constraint", () => {
      const schema = z.string().max(100);
      const result = zodToOpenAPI(schema);
      expect(result.maxLength).toBe(100);
    });

    it("handles regex pattern", () => {
      const schema = z.string().regex(/^[A-Z]+$/);
      const result = zodToOpenAPI(schema);
      expect(result.pattern).toBe("^[A-Z]+$");
    });

    it("handles email format", () => {
      const schema = z.string().email();
      const result = zodToOpenAPI(schema);
      expect(result.format).toBe("email");
    });

    it("handles url format", () => {
      const schema = z.string().url();
      const result = zodToOpenAPI(schema);
      expect(result.format).toBe("uri");
    });

    it("handles uuid format", () => {
      const schema = z.string().uuid();
      const result = zodToOpenAPI(schema);
      expect(result.format).toBe("uuid");
    });

    it("handles datetime format", () => {
      const schema = z.string().datetime();
      const result = zodToOpenAPI(schema);
      expect(result.format).toBe("date-time");
    });

    it("handles date format", () => {
      const schema = z.string().date();
      const result = zodToOpenAPI(schema);
      expect(result.format).toBe("date");
    });

    it("handles time format", () => {
      const schema = z.string().time();
      const result = zodToOpenAPI(schema);
      expect(result.format).toBe("time");
    });

    it("handles ip format", () => {
      const schema = z.string().ip();
      const result = zodToOpenAPI(schema);
      expect(result.format).toBe("ipv4");
    });

    it("combines multiple constraints", () => {
      const schema = z.string().min(1).max(50).email();
      const result = zodToOpenAPI(schema);
      expect(result).toEqual({
        type: "string",
        minLength: 1,
        maxLength: 50,
        format: "email",
      });
    });
  });

  describe("number constraints", () => {
    it("handles minimum constraint", () => {
      const schema = z.number().min(0);
      const result = zodToOpenAPI(schema);
      expect(result.minimum).toBe(0);
    });

    it("handles maximum constraint", () => {
      const schema = z.number().max(100);
      const result = zodToOpenAPI(schema);
      expect(result.maximum).toBe(100);
    });

    it("handles exclusive minimum", () => {
      const schema = z.number().gt(0);
      const result = zodToOpenAPI(schema);
      expect(result.exclusiveMinimum).toBe(0);
    });

    it("handles exclusive maximum", () => {
      const schema = z.number().lt(100);
      const result = zodToOpenAPI(schema);
      expect(result.exclusiveMaximum).toBe(100);
    });

    it("converts int to integer type", () => {
      const schema = z.number().int();
      const result = zodToOpenAPI(schema);
      expect(result.type).toBe("integer");
    });

    it("combines multiple constraints", () => {
      const schema = z.number().min(1).max(100).int();
      const result = zodToOpenAPI(schema);
      expect(result).toEqual({
        type: "integer",
        minimum: 1,
        maximum: 100,
      });
    });
  });

  describe("enums", () => {
    it("converts ZodEnum to OpenAPI enum", () => {
      const schema = z.enum(["active", "inactive", "pending"]);
      const result = zodToOpenAPI(schema);
      expect(result).toEqual({
        enum: ["active", "inactive", "pending"],
      });
    });

    it("converts native enum to OpenAPI enum", () => {
      enum Status {
        Active = "active",
        Inactive = "inactive",
      }
      const schema = z.nativeEnum(Status);
      const result = zodToOpenAPI(schema);
      expect(result.enum).toContain("active");
      expect(result.enum).toContain("inactive");
    });

    it("converts literal union to enum", () => {
      const schema = z.union([z.literal("a"), z.literal("b"), z.literal("c")]);
      const result = zodToOpenAPI(schema);
      expect(result.enum).toEqual(["a", "b", "c"]);
    });
  });

  describe("arrays", () => {
    it("converts array of strings", () => {
      const schema = z.array(z.string());
      const result = zodToOpenAPI(schema);
      expect(result).toEqual({
        type: "array",
        items: { type: "string" },
      });
    });

    it("converts array of numbers", () => {
      const schema = z.array(z.number());
      const result = zodToOpenAPI(schema);
      expect(result).toEqual({
        type: "array",
        items: { type: "number" },
      });
    });

    it("converts array of objects", () => {
      const schema = z.array(z.object({ id: z.string(), name: z.string() }));
      const result = zodToOpenAPI(schema);
      expect(result.type).toBe("array");
      expect(result.items.type).toBe("object");
      expect(result.items.properties).toHaveProperty("id");
      expect(result.items.properties).toHaveProperty("name");
    });

    it("handles min items constraint", () => {
      const schema = z.array(z.string()).min(1);
      const result = zodToOpenAPI(schema);
      expect(result.minItems).toBe(1);
    });

    it("handles max items constraint", () => {
      const schema = z.array(z.string()).max(10);
      const result = zodToOpenAPI(schema);
      expect(result.maxItems).toBe(10);
    });
  });

  describe("objects", () => {
    it("converts simple object", () => {
      const schema = z.object({
        id: z.string(),
        name: z.string(),
      });
      const result = zodToOpenAPI(schema);
      expect(result).toEqual({
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
        required: ["id", "name"],
      });
    });

    it("marks required fields", () => {
      const schema = z.object({
        id: z.string(),
        name: z.string(),
      });
      const result = zodToOpenAPI(schema);
      expect(result.required).toEqual(["id", "name"]);
    });

    it("excludes optional fields from required", () => {
      const schema = z.object({
        id: z.string(),
        name: z.string().optional(),
      });
      const result = zodToOpenAPI(schema);
      expect(result.required).toEqual(["id"]);
    });

    it("excludes nullable fields from required", () => {
      const schema = z.object({
        id: z.string(),
        name: z.string().nullable(),
      });
      const result = zodToOpenAPI(schema);
      expect(result.required).toEqual(["id"]);
    });

    it("excludes default fields from required", () => {
      const schema = z.object({
        id: z.string(),
        status: z.string().default("active"),
      });
      const result = zodToOpenAPI(schema);
      expect(result.required).toEqual(["id"]);
    });

    it("handles mixed required and optional fields", () => {
      const schema = z.object({
        id: z.string(),
        name: z.string().optional(),
        email: z.string().email(),
        phone: z.string().optional(),
      });
      const result = zodToOpenAPI(schema);
      expect(result.required).toEqual(["id", "email"]);
    });
  });

  describe("nested objects", () => {
    it("converts nested object", () => {
      const schema = z.object({
        id: z.string(),
        user: z.object({
          name: z.string(),
          email: z.string().email(),
        }),
      });
      const result = zodToOpenAPI(schema);
      expect(result.properties.user.type).toBe("object");
      expect(result.properties.user.properties).toHaveProperty("name");
      expect(result.properties.user.properties).toHaveProperty("email");
      expect(result.properties.user.required).toEqual(["name", "email"]);
    });

    it("converts deeply nested objects", () => {
      const schema = z.object({
        id: z.string(),
        data: z.object({
          nested: z.object({
            value: z.string(),
          }),
        }),
      });
      const result = zodToOpenAPI(schema);
      expect(
        result.properties.data.properties.nested.properties.value.type,
      ).toBe("string");
    });

    it("handles nested arrays of objects", () => {
      const schema = z.object({
        items: z.array(
          z.object({
            id: z.string(),
            tags: z.array(z.string()),
          }),
        ),
      });
      const result = zodToOpenAPI(schema);
      expect(result.properties.items.type).toBe("array");
      expect(result.properties.items.items.type).toBe("object");
      expect(result.properties.items.items.properties.tags.type).toBe("array");
      expect(result.properties.items.items.properties.tags.items.type).toBe(
        "string",
      );
    });
  });

  describe("optional fields", () => {
    it("handles optional string", () => {
      const schema = z.object({
        name: z.string().optional(),
      });
      const result = zodToOpenAPI(schema);
      expect(result.required).toEqual([]);
      expect(result.properties.name.type).toBe("string");
    });

    it("handles optional number", () => {
      const schema = z.object({
        age: z.number().optional(),
      });
      const result = zodToOpenAPI(schema);
      expect(result.required).toEqual([]);
      expect(result.properties.age.type).toBe("number");
    });

    it("handles optional object", () => {
      const schema = z.object({
        metadata: z.object({ key: z.string() }).optional(),
      });
      const result = zodToOpenAPI(schema);
      expect(result.required).toEqual([]);
      expect(result.properties.metadata.type).toBe("object");
    });

    it("handles optional array", () => {
      const schema = z.object({
        tags: z.array(z.string()).optional(),
      });
      const result = zodToOpenAPI(schema);
      expect(result.required).toEqual([]);
      expect(result.properties.tags.type).toBe("array");
    });
  });

  describe("nullable fields", () => {
    it("handles nullable string", () => {
      const schema = z.object({
        name: z.string().nullable(),
      });
      const result = zodToOpenAPI(schema);
      expect(result.required).toEqual(["name"]);
      expect(result.properties.name.type).toEqual(["string", "null"]);
    });

    it("handles nullable number", () => {
      const schema = z.object({
        age: z.number().nullable(),
      });
      const result = zodToOpenAPI(schema);
      expect(result.properties.age.type).toEqual(["number", "null"]);
    });

    it("handles nullable object", () => {
      const schema = z.object({
        metadata: z.object({ key: z.string() }).nullable(),
      });
      const result = zodToOpenAPI(schema);
      expect(result.properties.metadata.type).toEqual(["object", "null"]);
    });
  });

  describe("complex real-world schemas", () => {
    it("converts branding schema", () => {
      const schema = z.object({
        primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
        logoUrl: z.string().url().optional(),
        footerText: z.string().max(200).nullable().optional(),
      });
      const result = zodToOpenAPI(schema);
      expect(result.type).toBe("object");
      expect(result.required).toEqual(["primaryColor"]);
      expect(result.properties.primaryColor.pattern).toBe("^#[0-9A-Fa-f]{6}$");
      expect(result.properties.logoUrl.format).toBe("uri");
      expect(result.properties.footerText.maxLength).toBe(200);
    });

    it("converts invoice schema", () => {
      const schema = z.object({
        id: z.string().uuid(),
        clientEmail: z.string().email(),
        amount: z.number().positive(),
        status: z.enum(["pending", "paid", "overdue", "cancelled"]),
        items: z.array(
          z.object({
            description: z.string(),
            quantity: z.number().int().positive(),
            unitPrice: z.number().positive(),
          }),
        ),
        dueDate: z.string().date().optional(),
      });
      const result = zodToOpenAPI(schema);
      expect(result.type).toBe("object");
      expect(result.required).toEqual([
        "id",
        "clientEmail",
        "amount",
        "status",
        "items",
      ]);
      expect(result.properties.id.format).toBe("uuid");
      expect(result.properties.clientEmail.format).toBe("email");
      expect(result.properties.status.enum).toEqual([
        "pending",
        "paid",
        "overdue",
        "cancelled",
      ]);
      expect(result.properties.items.type).toBe("array");
      expect(result.properties.items.items.properties.quantity.type).toBe(
        "integer",
      );
    });

    it("converts user profile schema", () => {
      const schema = z.object({
        id: z.string(),
        email: z.string().email(),
        name: z.string().min(1).max(100),
        bio: z.string().max(500).optional(),
        avatar: z.string().url().nullable().optional(),
        role: z.enum(["user", "admin", "moderator"]),
        tags: z.array(z.string()).optional(),
        metadata: z
          .object({
            lastLogin: z.string().datetime().optional(),
            loginCount: z.number().int().min(0),
          })
          .optional(),
      });
      const result = zodToOpenAPI(schema);
      expect(result.required).toEqual(["id", "email", "name", "role"]);
      expect(result.properties.name.minLength).toBe(1);
      expect(result.properties.name.maxLength).toBe(100);
      expect(result.properties.metadata.properties.loginCount.minimum).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("handles empty object", () => {
      const schema = z.object({});
      const result = zodToOpenAPI(schema);
      expect(result).toEqual({
        type: "object",
        properties: {},
      });
    });

    it("handles object with only optional fields", () => {
      const schema = z.object({
        a: z.string().optional(),
        b: z.number().optional(),
      });
      const result = zodToOpenAPI(schema);
      expect(result.required).toEqual([]);
    });

    it("handles array of primitives", () => {
      const schema = z.array(z.string());
      const result = zodToOpenAPI(schema);
      expect(result.type).toBe("array");
      expect(result.items.type).toBe("string");
    });

    it("handles optional array of objects", () => {
      const schema = z.object({
        items: z.array(z.object({ id: z.string() })).optional(),
      });
      const result = zodToOpenAPI(schema);
      expect(result.required).toEqual([]);
      expect(result.properties.items.type).toBe("array");
    });
  });
});
