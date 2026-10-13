// ---------------------------------------------------------------------
// Turns anything thrown while extracting a PO from an invoice PDF into a
// short, safe, operator-facing message. The Anthropic SDK's own error
// message is the raw HTTP status plus the response JSON ("400 {"type":
// "error",...}"), which must never be shown to an operator. The raw
// detail is kept for the server log only.
//
// Every message ends by stating that no inventory was changed — that is
// true by construction: /api/intake/parse is a preview and writes nothing
// (POs are only created later by POST /api/intake/pos, after the operator
// confirms the Review screen).
//
// Classification is duck-typed (status + body shape) rather than
// `instanceof`, so it keeps working across SDK upgrades and is trivially
// testable without constructing SDK classes.
// ---------------------------------------------------------------------

export type InvoiceExtractionErrorCode =
  | "ai_credits_exhausted"
  | "ai_auth_failed"
  | "ai_misconfigured"
  | "ai_rate_limited"
  | "ai_overloaded"
  | "ai_unreachable"
  | "ai_not_configured"
  | "invoice_unreadable"
  | "ai_unexpected_error";

export interface InvoiceExtractionFailure {
  code: InvoiceExtractionErrorCode;
  /** Safe to show to the operator. */
  userMessage: string;
  /** HTTP status to return to the browser. */
  httpStatus: number;
  /** Worth trying again later without changing anything. */
  retryable: boolean;
  /** Server-log detail only — never sent to the browser. */
  logDetail: { status?: number; requestId?: string; rawMessage: string };
}

const NO_CHANGE = "No inventory was changed.";
const MANUAL = "You can still enter the purchase order manually.";
const NOT_CONFIGURED = `Automatic invoice extraction is temporarily unavailable because the AI service is not configured correctly. ${NO_CHANGE} ${MANUAL}`;

// A 400 whose body is about the API key / workspace / organization / billing
// setup (not about the document we sent).
const CONFIG_400 = /workspace|api[ -]?key|x-api-key|authenticat|permission|organization|billing|account|not scoped|disabled/i;
// A 400 that is genuinely about the PDF / document content.
const DOCUMENT_400 = /pdf|document|page|file|image|base64|media[ _]type|too large|too many/i;

/** Thrown by extractPOFromInvoice when the model returns nothing usable. */
export class InvoiceUnreadableError extends Error {
  constructor() {
    super("The AI could not extract structured data from this PDF.");
    this.name = "InvoiceUnreadableError";
  }
}

function anthropicBodyMessage(err: unknown): string {
  const body = (err as { error?: { error?: { message?: unknown }; message?: unknown } } | null | undefined)?.error;
  const nested = body?.error?.message ?? body?.message;
  return typeof nested === "string" ? nested : "";
}

export function classifyInvoiceExtractionError(err: unknown): InvoiceExtractionFailure {
  const e = err as { status?: unknown; requestID?: unknown; request_id?: unknown; name?: unknown; message?: unknown } | null | undefined;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const requestId = typeof e?.requestID === "string" ? e.requestID : typeof e?.request_id === "string" ? e.request_id : undefined;
  const rawMessage = typeof e?.message === "string" ? e.message : String(err);
  const detail = anthropicBodyMessage(err);
  const logDetail = { status, requestId, rawMessage };
  const base = (code: InvoiceExtractionErrorCode, userMessage: string, httpStatus: number, retryable: boolean): InvoiceExtractionFailure => ({
    code,
    userMessage,
    httpStatus,
    retryable,
    logDetail,
  });

  if (err instanceof InvoiceUnreadableError || e?.name === "InvoiceUnreadableError") {
    return base(
      "invoice_unreadable",
      `We couldn't read line items from this PDF. Try a clearer scan, or enter the purchase order manually. ${NO_CHANGE}`,
      422,
      false
    );
  }

  // Anthropic reports an empty balance as a 400 invalid_request_error whose
  // message names the credit balance.
  if (status === 400 && /credit balance/i.test(detail || rawMessage)) {
    return base(
      "ai_credits_exhausted",
      `Invoice extraction is temporarily unavailable because the AI service account needs credits. ${NO_CHANGE} ${MANUAL}`,
      503,
      true
    );
  }
  if (status === 401 || status === 403) {
    return base("ai_auth_failed", NOT_CONFIGURED, 503, false);
  }
  // Workspace-scope / key / billing / account setup problems also come back
  // as 400 invalid_request_error. That is a configuration issue, not a bad PDF.
  if (status === 400 && CONFIG_400.test(detail || rawMessage)) {
    return base("ai_misconfigured", NOT_CONFIGURED, 503, false);
  }
  if (status === 429) {
    return base("ai_rate_limited", `The AI service is busy right now. Please try again in a minute. ${NO_CHANGE}`, 503, true);
  }
  if (status === 529 || (status !== undefined && status >= 500)) {
    return base("ai_overloaded", `The AI service is temporarily unavailable. Please try again shortly. ${NO_CHANGE} ${MANUAL}`, 503, true);
  }
  // Connection/timeout failures carry no HTTP status. Matched on the message
  // (not the class name, which a minified server bundle can mangle).
  if (status === undefined && /connection error|timed? ?out|econn|enotfound|fetch failed|socket hang up/i.test(rawMessage)) {
    return base("ai_unreachable", `Couldn't reach the AI service. Please try again. ${NO_CHANGE}`, 503, true);
  }
  // Only blame the PDF when the API refused the document itself (413 is
  // payload-too-large; a 400/422 must actually talk about the document).
  if (status === 413 || ((status === 400 || status === 422) && DOCUMENT_400.test(detail || rawMessage))) {
    return base("invoice_unreadable", `This PDF couldn't be processed. Try a smaller or clearer file, or enter the purchase order manually. ${NO_CHANGE}`, 422, false);
  }
  return base("ai_unexpected_error", `Invoice extraction failed unexpectedly. ${NO_CHANGE} ${MANUAL}`, 500, true);
}

export const AI_NOT_CONFIGURED_FAILURE: InvoiceExtractionFailure = {
  code: "ai_not_configured",
  userMessage: `Invoice extraction isn't set up on this deployment yet. ${NO_CHANGE} ${MANUAL}`,
  httpStatus: 503,
  retryable: false,
  logDetail: { rawMessage: "ANTHROPIC_API_KEY is not set" },
};
