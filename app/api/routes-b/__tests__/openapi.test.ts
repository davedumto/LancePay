import { describe, it, expect, beforeEach } from "vitest";
import {
  registerRoute,
  generateOpenAPIDocument,
  getRegisteredRoutes,
  clearRegistry,
} from "../_lib/openapi";
import { z } from "zod";

describe("OpenAPI registry", () => {
  beforeEach(() => {
    clearRegistry();
  });

  it("registers routes", () => {
    registerRoute({
      method: "GET",
      path: "/test",
      summary: "Test endpoint",
      responseSchema: z.object({ message: z.string() }),
    });

    const routes = getRegisteredRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe("/test");
    expect(routes[0].summary).toBe("Test endpoint");
  });

  it("generates valid OpenAPI document", () => {
    registerRoute({
      method: "GET",
      path: "/stats",
      summary: "Get stats",
      responseSchema: z.object({ count: z.number() }),
    });

    registerRoute({
      method: "POST",
      path: "/invoices",
      summary: "Create invoice",
      requestSchema: z.object({ amount: z.number() }),
      responseSchema: z.object({ id: z.string() }),
    });

    const doc = generateOpenAPIDocument("http://localhost:3000");

    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("LancePay Routes-B API");
    expect(doc.paths["/stats"]).toBeDefined();
    expect(doc.paths["/invoices"]).toBeDefined();
    expect(doc.paths["/stats"].get.summary).toBe("Get stats");
    expect(doc.paths["/invoices"].post.summary).toBe("Create invoice");
  });

  it("includes security scheme", () => {
    const doc = generateOpenAPIDocument();
    expect(doc.components.securitySchemes.bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    });
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
  });

  it("handles missing fields gracefully", () => {
    registerRoute({
      method: "GET",
      path: "/simple",
      summary: "Simple endpoint",
      // No schemas, tags, or description
    });

    const doc = generateOpenAPIDocument();
    expect(doc.paths["/simple"].get.responses).toBeDefined();
    expect(doc.paths["/simple"].get.tags).toBeUndefined();
  });

  it("converts Zod schemas to OpenAPI", () => {
    const requestSchema = z.object({
      name: z.string(),
      age: z.number().optional(),
      tags: z.array(z.string()),
    });

    const responseSchema = z.object({
      id: z.string(),
      createdAt: z.string(),
    });

    registerRoute({
      method: "POST",
      path: "/users",
      summary: "Create user",
      requestSchema,
      responseSchema,
    });

    const doc = generateOpenAPIDocument();
    const operation = doc.paths["/users"].post;

    expect(
      operation.requestBody.content["application/json"].schema,
    ).toBeDefined();
    expect(
      operation.responses["200"].content["application/json"].schema,
    ).toBeDefined();
  });

  it("handles different HTTP methods on same path", () => {
    registerRoute({
      method: "GET",
      path: "/items",
      summary: "Get items",
    });

    registerRoute({
      method: "POST",
      path: "/items",
      summary: "Create item",
    });

    const doc = generateOpenAPIDocument();
    expect(doc.paths["/items"].get).toBeDefined();
    expect(doc.paths["/items"].post).toBeDefined();
  });

  it("converts enum schemas correctly", () => {
    registerRoute({
      method: "POST",
      path: "/invoices",
      summary: "Create invoice",
      requestSchema: z.object({
        status: z.enum(["pending", "paid", "overdue"]),
      }),
      responseSchema: z.object({
        id: z.string(),
        status: z.enum(["pending", "paid", "overdue"]),
      }),
    });

    const doc = generateOpenAPIDocument();
    const operation = doc.paths["/invoices"].post;
    const requestSchema =
      operation.requestBody.content["application/json"].schema;
    const responseSchema =
      operation.responses["200"].content["application/json"].schema;

    expect(requestSchema.properties.status.enum).toEqual([
      "pending",
      "paid",
      "overdue",
    ]);
    expect(responseSchema.properties.status.enum).toEqual([
      "pending",
      "paid",
      "overdue",
    ]);
  });

  it("converts nested object schemas correctly", () => {
    registerRoute({
      method: "POST",
      path: "/users",
      summary: "Create user",
      requestSchema: z.object({
        name: z.string(),
        profile: z.object({
          bio: z.string().optional(),
          avatar: z.string().url().optional(),
        }),
      }),
    });

    const doc = generateOpenAPIDocument();
    const operation = doc.paths["/users"].post;
    const schema = operation.requestBody.content["application/json"].schema;

    expect(schema.properties.profile.type).toBe("object");
    expect(schema.properties.profile.properties.bio.type).toBe("string");
    expect(schema.properties.profile.properties.avatar.format).toBe("uri");
    expect(schema.properties.profile.required).toEqual([]);
  });

  it("converts array of objects correctly", () => {
    registerRoute({
      method: "POST",
      path: "/invoices",
      summary: "Create invoice",
      requestSchema: z.object({
        items: z.array(
          z.object({
            description: z.string(),
            quantity: z.number().int().positive(),
            unitPrice: z.number().positive(),
          }),
        ),
      }),
    });

    const doc = generateOpenAPIDocument();
    const operation = doc.paths["/invoices"].post;
    const schema = operation.requestBody.content["application/json"].schema;

    expect(schema.properties.items.type).toBe("array");
    expect(schema.properties.items.items.type).toBe("object");
    expect(schema.properties.items.items.properties.quantity.type).toBe(
      "integer",
    );
    expect(schema.properties.items.items.properties.quantity.minimum).toBe(0);
  });

  it("handles string constraints in OpenAPI", () => {
    registerRoute({
      method: "POST",
      path: "/users",
      summary: "Create user",
      requestSchema: z.object({
        email: z.string().email(),
        name: z.string().min(1).max(100),
        website: z.string().url().optional(),
      }),
    });

    const doc = generateOpenAPIDocument();
    const operation = doc.paths["/users"].post;
    const schema = operation.requestBody.content["application/json"].schema;

    expect(schema.properties.email.format).toBe("email");
    expect(schema.properties.name.minLength).toBe(1);
    expect(schema.properties.name.maxLength).toBe(100);
    expect(schema.properties.website.format).toBe("uri");
  });

  it("handles number constraints in OpenAPI", () => {
    registerRoute({
      method: "POST",
      path: "/products",
      summary: "Create product",
      requestSchema: z.object({
        price: z.number().min(0).max(1000000),
        quantity: z.number().int().min(1),
      }),
    });

    const doc = generateOpenAPIDocument();
    const operation = doc.paths["/products"].post;
    const schema = operation.requestBody.content["application/json"].schema;

    expect(schema.properties.price.minimum).toBe(0);
    expect(schema.properties.price.maximum).toBe(1000000);
    expect(schema.properties.quantity.type).toBe("integer");
    expect(schema.properties.quantity.minimum).toBe(1);
  });

  it("marks optional fields correctly", () => {
    registerRoute({
      method: "POST",
      path: "/users",
      summary: "Create user",
      requestSchema: z.object({
        email: z.string().email(),
        name: z.string(),
        bio: z.string().optional(),
        phone: z.string().optional(),
      }),
    });

    const doc = generateOpenAPIDocument();
    const operation = doc.paths["/users"].post;
    const schema = operation.requestBody.content["application/json"].schema;

    expect(schema.required).toEqual(["email", "name"]);
  });

  it("handles nullable fields in OpenAPI", () => {
    registerRoute({
      method: "POST",
      path: "/users",
      summary: "Create user",
      requestSchema: z.object({
        name: z.string(),
        bio: z.string().nullable(),
      }),
    });

    const doc = generateOpenAPIDocument();
    const operation = doc.paths["/users"].post;
    const schema = operation.requestBody.content["application/json"].schema;

    expect(schema.required).toEqual(["name", "bio"]);
    expect(schema.properties.bio.type).toEqual(["string", "null"]);
  });
});
