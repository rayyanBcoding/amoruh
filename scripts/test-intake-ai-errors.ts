// Regression tests for the Inventory Intake invoice-extraction error handling.
// Pure unit tests built from the Anthropic SDK's real error classes; no
// network, no Redis. Run any time with:
//   npx tsx scripts/test-intake-ai-errors.ts
import Anthropic from "@anthropic-ai/sdk";
import { AI_NOT_CONFIGURED_FAILURE, InvoiceUnreadableError, classifyInvoiceExtractionError } from "../src/lib/intake-ai-errors";

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else {
    fail++;
    console.log(`FAIL: ${label}\n   expected ${JSON.stringify(expected)}\n   got      ${JSON.stringify(actual)}`);
  }
}

const creditBody = {
  type: "error",
  error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." },
  request_id: "req_credit",
};
const apiErr = (status: number, body: object, reqId = "req_x") => Anthropic.APIError.generate(status, body, undefined, new Headers({ "request-id": reqId }));
const genericBody = (message: string) => ({ type: "error", error: { type: "api_error", message }, request_id: "req_x" });

// ---- the production failure, exactly as the SDK throws it ----
const credit = classifyInvoiceExtractionError(apiErr(400, creditBody, "req_credit"));
check("credit-balance 400 -> ai_credits_exhausted", credit.code, "ai_credits_exhausted");
check("...is a 503 the UI can treat as 'service unavailable'", credit.httpStatus, 503);
check("...is retryable once credits are added", credit.retryable, true);
check(
  "...uses the agreed operator message",
  credit.userMessage.startsWith("Invoice extraction is temporarily unavailable because the AI service account needs credits. No inventory was changed."),
  true
);
check("...keeps the raw detail for the server log only (request id captured)", credit.logDetail.requestId, "req_credit");
check("...and the raw SDK message is retained in logDetail", credit.logDetail.rawMessage.includes("credit balance"), true);

// ---- no failure message may ever leak provider JSON / ids / internals ----
const cases: [string, unknown][] = [
  ["credit", apiErr(400, creditBody)],
  ["401", apiErr(401, genericBody("invalid x-api-key"))],
  ["403", apiErr(403, genericBody("forbidden"))],
  ["429", apiErr(429, genericBody("rate limited"))],
  ["500", apiErr(500, genericBody("boom"))],
  ["529", apiErr(529, genericBody("overloaded"))],
  ["400 other", apiErr(400, genericBody("pdf is too large"))],
  ["connection", new Anthropic.APIConnectionError({ message: "Connection error." })],
  ["timeout", new Anthropic.APIConnectionTimeoutError()],
  ["unreadable", new InvoiceUnreadableError()],
  ["plain Error", new Error('400 {"type":"error","error":{"message":"secret internal"}}')],
  ["string", "something odd"],
  ["null", null],
];
for (const [label, err] of cases) {
  const f = classifyInvoiceExtractionError(err);
  const m = f.userMessage;
  check(`${label}: no JSON braces/quotes-of-json in the message`, /[{}]|"type"|invalid_request_error|request_id|req_|x-api-key|sk-ant/i.test(m), false);
  check(`${label}: states that no inventory was changed`, /no inventory was changed/i.test(m), true);
  check(`${label}: has an http status`, f.httpStatus >= 400 && f.httpStatus < 600, true);
}
check("not-configured failure is clean too", /No inventory was changed/.test(AI_NOT_CONFIGURED_FAILURE.userMessage) && !/ANTHROPIC_API_KEY/.test(AI_NOT_CONFIGURED_FAILURE.userMessage), true);

// ---- classification table ----
check("401 -> ai_auth_failed", classifyInvoiceExtractionError(apiErr(401, genericBody("bad key"))).code, "ai_auth_failed");
check("403 -> ai_auth_failed", classifyInvoiceExtractionError(apiErr(403, genericBody("x"))).code, "ai_auth_failed");
check("429 -> ai_rate_limited (retryable)", [classifyInvoiceExtractionError(apiErr(429, genericBody("x"))).code, classifyInvoiceExtractionError(apiErr(429, genericBody("x"))).retryable], ["ai_rate_limited", true]);
check("529 -> ai_overloaded", classifyInvoiceExtractionError(apiErr(529, genericBody("x"))).code, "ai_overloaded");
check("500 -> ai_overloaded", classifyInvoiceExtractionError(apiErr(500, genericBody("x"))).code, "ai_overloaded");
check("connection error -> ai_unreachable", classifyInvoiceExtractionError(new Anthropic.APIConnectionError({ message: "Connection error." })).code, "ai_unreachable");
check("timeout -> ai_unreachable", classifyInvoiceExtractionError(new Anthropic.APIConnectionTimeoutError()).code, "ai_unreachable");
check("a non-billing 400 is NOT mistaken for a credit problem", classifyInvoiceExtractionError(apiErr(400, genericBody("pdf is too large"))).code, "invoice_unreadable");
check("an unreadable invoice is a 422, not retryable", [classifyInvoiceExtractionError(new InvoiceUnreadableError()).httpStatus, classifyInvoiceExtractionError(new InvoiceUnreadableError()).retryable], [422, false]);
check("unknown errors fall back safely", classifyInvoiceExtractionError(new Error("anything")).code, "ai_unexpected_error");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
