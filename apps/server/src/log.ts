import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger };

/**
 * Logs carry kinds, ids and counts only. Message content, tokens and secrets are never passed to the logger;
 * `redact` is a second line of defence if someone does it by mistake.
 */
export const createLogger = (level: string, dest?: DestinationStream): Logger =>
  pino(
    {
      level,
      redact: {
        paths: ['token', 'content', 'secret', 'ticket', 'authorization', '*.token', '*.content', '*.secret', '*.ticket', '*.authorization', 'req.headers.authorization', 'inviteSecret', 'adminSecret', 'viewSecret'],
        censor: '[redacted]',
      },
    },
    dest,
  );

/** The only thing an unexpected error contributes to a log line: its class name (messages can carry content). */
export const errKind = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

/** Access-log path: query dropped (WS tickets), `/mcp/<token>` fallback token replaced. */
export const redactPath = (pathname: string): string => pathname.replace(/^\/mcp\/.*/, '/mcp/<redacted>');
