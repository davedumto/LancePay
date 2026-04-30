import { NextResponse } from 'next/server'

/**
 * Ensures that the requested resource belongs to the requesting user.
 * Returns a 404 Not Found response if it belongs to someone else, to prevent existence leaks.
 * Returns null if ownership is valid.
 */
export function checkResourceOwnership(resourceUserId: string, currentUserId: string): NextResponse | null {
  if (resourceUserId !== currentUserId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return null
}

/**
 * Ensures that the requesting user has the appropriate scope/permissions for the resource.
 * Returns a 403 Forbidden response if the scope check fails.
 * Returns null if the scope is valid.
 */
export function checkScopeAccess(hasScope: boolean): NextResponse | null {
  if (!hasScope) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}
