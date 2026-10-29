export type TransportFailure = 'timeout' | 'aborted' | 'network' | 'redirect' | 'protocol';
export type RequestOutcome = 'not_sent' | 'unknown';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly details: unknown;
  readonly idempotencyKey: string | undefined;

  constructor(input: { status: number; code: string; message: string; requestId?: string | undefined; details?: unknown; idempotencyKey?: string | undefined }) {
    super(input.message);
    this.name = 'ApiError';
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId;
    this.details = input.details;
    this.idempotencyKey = input.idempotencyKey;
  }

  /** Response bodies/credentials are never retained or serialized here. */
  toJSON(): Record<string, unknown> {
    return { name: this.name, status: this.status, code: this.code, requestId: this.requestId, idempotencyKey: this.idempotencyKey };
  }
}

/**
 * A transport error cannot establish whether a dispatched mutation committed.
 * Retry only an explicitly prepared operation, with the same key and snapshot.
 */
export class TransportError extends Error {
  readonly kind: TransportFailure;
  readonly outcome: RequestOutcome;
  readonly requestId: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly replaySafe: boolean;

  constructor(input: { kind: TransportFailure; outcome: RequestOutcome; message: string; requestId?: string | undefined; idempotencyKey?: string | undefined; replaySafe?: boolean }) {
    super(input.message);
    this.name = 'TransportError';
    this.kind = input.kind;
    this.outcome = input.outcome;
    this.requestId = input.requestId;
    this.idempotencyKey = input.idempotencyKey;
    this.replaySafe = input.replaySafe === true;
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, kind: this.kind, outcome: this.outcome, requestId: this.requestId, idempotencyKey: this.idempotencyKey, replaySafe: this.replaySafe };
  }
}
