import winston from 'winston';

const logLevel = process.env.LOG_LEVEL || 'info';

const redactString = (value: string): string =>
  value
    .replace(/([?&]X-Plex-Token=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/(["']?X-Plex-Token["']?\s*[:=]\s*["']?)[^"',}\s]+/gi, '$1[REDACTED]')
    .replace(
      /(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi,
      '$1[REDACTED]'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');

export const redactForLog = (
  value: unknown,
  key = '',
  depth = 0,
  seen = new WeakSet<object>()
): unknown => {
  if (/token|authorization|cookie/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    const error = value as Error & { code?: unknown; status?: unknown };
    return {
      name: error.name,
      message: redactString(error.message),
      stack: error.stack ? redactString(error.stack) : undefined,
      code: error.code,
      status: error.status,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const previous = index > 0 ? value[index - 1] : undefined;
      if (
        typeof previous === 'string' &&
        /^(?:authorization|proxy-authorization|cookie|set-cookie|x-plex-token)$/i.test(previous)
      ) {
        return '[REDACTED]';
      }
      return redactForLog(item, '', depth + 1, seen);
    });
  }

  const sanitized: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    try {
      sanitized[childKey] = redactForLog(childValue, childKey, depth + 1, seen);
    } catch {
      sanitized[childKey] = '[Unavailable]';
    }
  }
  return sanitized;
};

const redactFormat = winston.format(info => {
  for (const key of Object.keys(info)) {
    if (key === 'level' || key === 'timestamp' || key === 'service') continue;
    info[key] = redactForLog(info[key], key);
  }
  return info;
});

export const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    redactFormat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'librarydownloadarr' },
  transports: [
    // Console output
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          let msg = `${timestamp} [${level}]: ${message}`;
          if (Object.keys(meta).length > 0 && meta.service !== 'librarydownloadarr') {
            msg += ` ${JSON.stringify(meta)}`;
          }
          return msg;
        })
      ),
    }),
    // Error log file
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
    }),
    // Combined log file
    new winston.transports.File({
      filename: 'logs/combined.log',
    }),
  ],
});
