/**
 * Canonical _shared entry-point for the request-id correlation middleware.
 * Implementation lives in _lib/with-request-id to keep it co-located with
 * the schema-version utilities it depends on.
 */
export { withRequestId, getRequestId } from '../_lib/with-request-id'
