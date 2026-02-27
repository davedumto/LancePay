import pino from 'pino';

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
  transport,
});

/**
 * Enhanced error logging that works with the new pino logger.
 */
export const logError = (error: Error, errorInfo?: { [key: string]: any }) => {
  logger.error({ err: error, ...errorInfo }, error.message);
};

// Also export standard pino methods for convenience if needed
export default logger;
