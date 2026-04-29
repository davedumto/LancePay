import { NextResponse } from "next/server";

export const ROUTES_B_ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "INTERNAL",
] as const;

export type RoutesBErrorCode = (typeof ROUTES_B_ERROR_CODES)[number];

type ErrorFields = Record<string, string | string[]>;
type ErrorDetails = Record<string, unknown>;

export function errorResponse(
  code: RoutesBErrorCode,
  message: string,
  options?: {
    fields?: ErrorFields;
    details?: ErrorDetails;
    requestId?: string | null;
  },
  status = 400,
) {
  const requestId = options?.requestId ?? crypto.randomUUID();

  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...(options?.fields ? { fields: options.fields } : {}),
        ...(options?.details ? { details: options.details } : {}),
      },
      requestId,
    },
    {
      status,
      headers: {
        "X-Request-Id": requestId, // preserve traceability like the first version
      },
    },
  );
}