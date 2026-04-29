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

export function errorResponse(
  code: RoutesBErrorCode,
  message: string,
  fields?: ErrorFields,
  status = 400,
  requestId?: string | null,
) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...(fields ? { fields } : {}),
      },
      requestId: requestId ?? crypto.randomUUID(),
    },
    { status },
  );
}
