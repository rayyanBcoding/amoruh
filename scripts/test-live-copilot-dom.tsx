// DOM interaction checks without changing application dependencies:
// npm_config_cache=/tmp/amoruh-npm-cache npm install --prefix /tmp/amoruh-copilot-dom --no-save --no-package-lock jsdom
// npm_config_cache=/tmp/amoruh-npm-cache npx --yes tsx scripts/test-live-copilot-dom.tsx
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { act, createElement } from "react";
import seed from "../data/products.json";
import type { Product } from "../src/lib/types";
import { CompactCopilotCard } from "../src/components/golive/CompactCopilotCard";
import { useCopilotHistory } from "../src/components/golive/useCopilotHistory";

async function main() {
  const { JSDOM } = createRequire("/tmp/amoruh-copilot-dom/package.json")("jsdom");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  const requests: { url: string; signal: AbortSignal; resolve: (value: Response) => void }[] = [];
  globalThis.fetch = (url, init) => new Promise<Response>((resolve) => requests.push({ url: String(url), signal: init!.signal!, resolve }));
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const p = { ...seed[0], id: "one", brand: "Afnan", name: "9PM", retailReference: undefined } as Product;
  function Harness({ product, revision }: { product: Product; revision: string }) {
    const history = useCopilotHistory(revision);
    return createElement(CompactCopilotCard, { key: product.id, product, financials: null, history: { state: history.state, row: history.rows.find((r) => r.productId === product.id) ?? null } });
  }
  const render = (product: Product, revision = "session:0") => act(async () => { root.render(createElement(Harness, { product, revision })); });
  const button = () => document.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
  try {
    await render(p);
    assert.match(document.body.textContent!, /Afnan 9PM/); // appears while history is still pending
    assert.equal(requests.length, 1);
    assert.equal(button().getAttribute("aria-expanded"), "false");
    assert.equal(document.querySelector("img"), null);
    button().focus();
    await act(async () => button().click());
    assert.equal(button().getAttribute("aria-expanded"), "true");
    assert.match(document.body.textContent!, /Actual item cost/);
    assert.match(document.body.textContent!, /Print Label/);
    assert.equal(document.activeElement, button()); // no auto-focus or modal interception
    await render({ ...p, inventory: 2 }); // ordinary polling must not collapse details
    assert.equal(button().getAttribute("aria-expanded"), "true");
    await render({ ...p, id: "two", name: "Next fragrance" });
    assert.equal(button().getAttribute("aria-expanded"), "false"); // next product remounts closed
    assert.doesNotMatch(document.body.textContent!, /Actual item cost/);
    assert.equal(requests.length, 1); // scanning doesn't fan out history requests
    await act(async () => requests[0].resolve(new Response(JSON.stringify({ rows: [] }), { status: 200 })));
    await render(p, "session:1");
    await render(p, "session:2");
    assert.equal(requests[1].signal.aborted, true);
    await act(async () => requests[2].resolve(new Response(JSON.stringify({ rows: [] }), { status: 200 })));
    await act(async () => requests[1].resolve(new Response(JSON.stringify({ rows: [{ productId: "one", units: 1000 }] }), { status: 200 })));
    await act(async () => button().click());
    assert.doesNotMatch(document.body.textContent!, /1000 units/); // stale response is discarded
    assert.equal(requests.every((r) => r.url === "/api/reorder-intelligence?window=last5"), true);
    assert.equal(document.querySelectorAll('[role="status"]').length, 1);
    console.log("Copilot DOM: immediate card with pending history, collapsed/open More, focus preservation, polling retention, next-product collapse, no history requests per scan, and stale-response rejection passed.");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
