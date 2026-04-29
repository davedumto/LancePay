/**
 * Feature flag system for routes-b.
 * 
 * Flags can be controlled via environment variables:
 * - FLAG_<FLAG_NAME>=on|off|userIds
 *   - "on": enabled for all users
 *   - "off": disabled for all users
 *   - "userIds": comma-separated list of user IDs that have access
 * 
 * If no env var is set, falls back to default map.
 */

type FlagContext = {
  userId?: string;
};

type FlagValue = 'on' | 'off' | string[]; // string[] = list of user IDs

const defaultFlags: Record<string, FlagValue> = {
  // Example defaults - these should be conservative (off by default)
  'bulk-contacts-import': 'off',
  'presigned-uploads': 'off',
  'sparkline-charts': 'off',
  'webhook-event-filtering': 'off',
};

export const ENABLE_CONTACTS_SOFT_DELETE = process.env.ENABLE_CONTACTS_SOFT_DELETE === 'true' ||
  process.env.FLAG_CONTACTS_SOFT_DELETE === 'on'

function parseFlagValue(envValue: string | undefined): FlagValue {
  if (!envValue) return 'off';
  
  const trimmed = envValue.trim().toLowerCase();
  if (trimmed === 'on') return 'on';
  if (trimmed === 'off') return 'off';
  
  // Parse comma-separated user IDs
  const userIds = trimmed.split(',').map(id => id.trim()).filter(Boolean);
  return userIds;
}

function getEnvFlagValue(flagName: string): FlagValue | null {
  const envKey = `FLAG_${flagName.toUpperCase().replace(/-/g, '_')}`;
  const envValue = process.env[envKey];
  if (envValue === undefined) return null;
  
  return parseFlagValue(envValue);
}

// Simple memoization cache per request (in-memory, cleared per request)
const flagCache = new Map<string, FlagValue>();

/**
 * Check if a feature flag is enabled for the given context.
 * 
 * @param flagName - Name of the feature flag
 * @param context - Context containing userId (optional)
 * @returns boolean indicating if the feature is enabled
 */
export function isEnabled(flagName: string, context: FlagContext = {}): boolean {
  // Check cache first
  const cacheKey = `${flagName}:${context.userId || 'no-user'}`;
  if (flagCache.has(cacheKey)) {
    const cached = flagCache.get(cacheKey)
    return cached === 'on' ||
      Boolean(Array.isArray(cached) && context.userId && cached.includes(context.userId))
  }
  
  // Get flag value from env or defaults
  let flagValue: FlagValue = getEnvFlagValue(flagName) || defaultFlags[flagName] || 'off';
  
  // Cache the raw flag value (not the evaluated result)
  flagCache.set(cacheKey, flagValue);
  
  // Evaluate based on flag value type
  if (flagValue === 'on') return true;
  if (flagValue === 'off') return false;
  if (Array.isArray(flagValue) && context.userId) {
    return flagValue.includes(context.userId);
  }
  
  return false;
}

/**
 * Clear the flag cache (should be called at the start of each request).
 */
export function clearFlagCache(): void {
  flagCache.clear();
}
