/**
 * OpenAPI 3.1 registry and generator for routes-b endpoints.
 *
 * Each route can register its documentation, which is then assembled
 * into a complete OpenAPI document available at GET /_openapi.
 */

import { z } from "zod";
import { zodToOpenAPI } from "./zod-to-openapi";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteRegistration {
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  requestSchema?: z.ZodTypeAny;
  responseSchema?: z.ZodTypeAny;
  tags?: string[];
  deprecated?: boolean;
}

// Internal registry
const registry: RouteRegistration[] = [];

/**
 * Register a route for OpenAPI documentation.
 */
export function registerRoute(registration: RouteRegistration): void {
  registry.push(registration);
}

/**
 * Generate the complete OpenAPI 3.1 document.
 */
export function generateOpenAPIDocument(
  baseUrl: string = "http://localhost:3000",
): any {
  const paths: Record<string, any> = {};

  registry.forEach((route) => {
    const pathKey = route.path.startsWith("/") ? route.path : `/${route.path}`;

    if (!paths[pathKey]) {
      paths[pathKey] = {};
    }

    const operation: any = {
      summary: route.summary,
      ...(route.description && { description: route.description }),
      ...(route.tags && { tags: route.tags }),
      ...(route.deprecated && { deprecated: true }),
      responses: {
        "200": {
          description: "Success",
          ...(route.responseSchema && {
            content: {
              "application/json": {
                schema: zodToOpenAPI(route.responseSchema),
              },
            },
          }),
        },
        "400": { description: "Bad Request" },
        "401": { description: "Unauthorized" },
        "403": { description: "Forbidden" },
        "404": { description: "Not Found" },
        "500": { description: "Internal Server Error" },
      },
    };

    if (route.requestSchema) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: zodToOpenAPI(route.requestSchema),
          },
        },
      };
    }

    paths[pathKey][route.method.toLowerCase()] = operation;
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "LancePay Routes-B API",
      description: "API for LancePay routes-b endpoints",
      version: "1.0.0",
    },
    servers: [{ url: baseUrl, description: "Development server" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    security: [{ bearerAuth: [] }],
  };
}

/**
 * Get all registered routes (for testing/debugging).
 */
export function getRegisteredRoutes(): RouteRegistration[] {
  return [...registry];
}

/**
 * Clear the registry (for testing).
 */
export function clearRegistry(): void {
  registry.length = 0;
}
