import pino from 'pino';

const redactionPaths = [
  'req.headers.authorization',
  'authorization',
  'req.headers.cookie',
  'cookie',
  'req.headers["x-yc-signature"]',
  'x-yc-signature',
  'req.headers["moonpay-signature"]',
  'moonpay-signature',
  'req.headers["moonpay-signature-v2"]',
  'moonpay-signature-v2',
  'req.headers.signature',
  'signature',
  'apiKey',
  'api_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'secret',
  'clientSecret',
  'client_secret',
  'webhookSecret',
  'webhook_secret',
  'privateKey',
  'private_key',
  'password',
  'accountNumber',
  'twoFactorSecret',
];

const redact = {
  paths: redactionPaths,
  censor: '[Redacted]',
};

const sensitiveFieldNames = new Set([
  'authorization',
  'cookie',
  'x-yc-signature',
  'moonpay-signature',
  'moonpay-signature-v2',
  'signature',
  'apikey',
  'api_key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'secret',
  'clientsecret',
  'client_secret',
  'webhooksecret',
  'webhook_secret',
  'privatekey',
  'private_key',
  'password',
  'accountnumber',
  'twofactorsecret',
]);

function stripSensitiveFields(value: any): any {
  if (Array.isArray(value)) return value.map(stripSensitiveFields)
  if (!value || typeof value !== 'object' || value instanceof Error || value instanceof Date) {
    return value
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      sensitiveFieldNames.has(key.toLowerCase()) ? '[Redacted]' : stripSensitiveFields(nested),
    ])
  )
}

const isDevelopment = process.env.NODE_ENV === 'development';

const transport = isDevelopment
  ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  }
  : undefined;

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  base: {
    env: process.env.NODE_ENV,
    revision: process.env.VERCEL_GIT_COMMIT_SHA,
  },
  redact,
  transport,
});

export { redact };

/**
 * Enhanced error logging that works with the new pino logger.
 */
export const logError = (error: Error, errorInfo?: { [key: string]: any }) => {
  logger.error({ err: error, ...stripSensitiveFields(errorInfo) }, error.message);
};

// Also export standard pino methods for convenience if needed
export default logger;
