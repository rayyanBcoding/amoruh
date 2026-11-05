// Errors carry only what is safe to log: TikTok's numeric code, message,
// request_id and the HTTP status. NEVER a URL (token endpoints take the app
// secret in the query string), headers, tokens or response payloads.

export class TikTokApiError extends Error {
  readonly code: number | null;
  readonly requestId: string | null;
  readonly httpStatus: number | null;

  constructor(message: string, opts: { code?: number | null; requestId?: string | null; httpStatus?: number | null } = {}) {
    super(message);
    this.name = "TikTokApiError";
    this.code = opts.code ?? null;
    this.requestId = opts.requestId ?? null;
    this.httpStatus = opts.httpStatus ?? null;
  }

  /** One-line description that is safe for logs and API responses. */
  describe(): string {
    const bits = [this.message];
    if (this.code !== null) bits.push(`code ${this.code}`);
    if (this.httpStatus !== null) bits.push(`HTTP ${this.httpStatus}`);
    if (this.requestId) bits.push(`request_id ${this.requestId}`);
    return bits.join(" · ");
  }
}

/** Thrown BEFORE any network call when code tries a non-allow-listed operation. */
export class ReadOnlyViolationError extends Error {
  constructor(method: string, path: string) {
    super(`Blocked: ${method} ${path} is not an allow-listed read-only TikTok operation.`);
    this.name = "ReadOnlyViolationError";
  }
}

/** Retry only what is safe and likely transient: timeouts, 5xx, throttling. */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof TikTokApiError)) return false;
  if (err.httpStatus === 429 || (err.httpStatus !== null && err.httpStatus >= 500)) return true;
  if (err.code === 36009002) return true; // TikTok throttling
  return err.httpStatus === null && err.code === null; // network/timeout (no response at all)
}
