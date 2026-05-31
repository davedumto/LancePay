import { NextRequest, NextResponse } from 'next/server'

type MethodHandler = (request: NextRequest) => Promise<Response> | Response

type MethodMap = {
  GET?: MethodHandler
  POST?: MethodHandler
  PUT?: MethodHandler
  PATCH?: MethodHandler
  DELETE?: MethodHandler
  HEAD?: MethodHandler
  OPTIONS?: MethodHandler
}

function methodNotAllowed(allowedMethods: string[]): Response {
  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: {
      'Allow': allowedMethods.join(', '),
      'Content-Type': 'application/json',
    },
  })
}

export function withMethods(methods: MethodMap) {
  const allowedMethods = Object.keys(methods).filter(m => methods[m as keyof MethodMap] !== undefined)
  
  const result: Record<string, MethodHandler> = {}
  
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const) {
    result[method] = methods[method] ?? (() => methodNotAllowed(allowedMethods))
  }
  
  return result as {
    GET: MethodHandler
    POST: MethodHandler
    PUT: MethodHandler
    PATCH: MethodHandler
    DELETE: MethodHandler
    HEAD: MethodHandler
    OPTIONS: MethodHandler
  }
}