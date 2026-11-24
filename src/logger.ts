import { pino, type Logger } from 'pino';

export type { Logger };

/** Paths that must never reach a log line, whatever object they are nested in. */
const REDACT = [
  'token',
  'apiKey',
  'key',
  'authorization',
  'headers["x-api-key"]',
  'headers.authorization',
  '*.token',
  '*.apiKey',
  '*.headers["x-api-key"]',
  '*.headers.authorization',
  'config.discord.token',
  'config.roblox.apiKey',
];

export function createLogger(level: string = 'info', pretty = false): Logger {
  return pino({
    level,
    base: { app: 'hk1941-bot' },
    redact: { paths: REDACT, censor: '[redacted]' },
    transport: pretty
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,app' } }
      : undefined,
  });
}

/** A logger that drops everything, for tests and tools. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
