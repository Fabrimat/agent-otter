import type { ErrorCode } from '@agent-office/protocol';

/** Expected failure with a protocol ErrorCode; the message is safe to show to the caller (never contains secrets or content). */
export class StoreError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
  }
}
