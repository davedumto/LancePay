export const ROUTES_B_SCHEMA_VERSION = '1.0.0'

export function isSchemaCompatible(clientSchema: string): boolean {
  if (!clientSchema) return true
  // We use a simple caret-like logic: major version must match, minor can be greater/equal
  const [clientMajor, clientMinor] = clientSchema.split('.').map(Number)
  const [serverMajor, serverMinor] = ROUTES_B_SCHEMA_VERSION.split('.').map(Number)
  
  if (clientMajor !== serverMajor) return false
  if (clientMinor > serverMinor) return false // client expects features we don't have
  return true
}
