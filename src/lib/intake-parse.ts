import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { ExtractedPO } from "./intake-types";

// ---------------------------------------------------------------------
// PDF -> structured PO extraction, via a single Claude API call.
//
// The PDF is already sitting in Vercel Blob (public URL) by the time this
// runs — see /api/intake/upload — so we pass it straight to Claude as a
// `document` content block with a `url` source, no separate Files API
// upload/cleanup to manage.
// ---------------------------------------------------------------------

const LineItemSchema = z.object({
  rawDescription: z.string().describe("The line item description exactly as printed on the invoice."),
  upc: z.string().describe("Manufacturer UPC/barcode for this item, if printed on the invoice. Empty string if not present."),
  brand: z.string().describe("Best-guess brand name parsed out of the description."),
  name: z.string().describe("Best-guess product name (without brand/size), parsed out of the description."),
  size: z.string().describe("Size, e.g. '100ml' or '3.4oz'. Empty string if not determinable."),
  concentration: z.string().describe("e.g. 'Eau de Toilette', 'Eau de Parfum', 'Parfum'. Empty string if not determinable."),
  quantity: z.number().describe("Quantity ordered for this line."),
  unitCost: z.number().describe("Cost per unit for this line, in the invoice's currency."),
  lineTotal: z.number().describe("Total for this line (quantity * unitCost), as printed."),
});

const ExtractedPOSchema = z.object({
  poNumber: z.string().describe("Purchase order number or invoice number printed on the document."),
  supplierName: z.string().describe("The supplier/vendor's company name."),
  invoiceDate: z.string().describe("Invoice date in YYYY-MM-DD format. Best guess if the printed format is ambiguous."),
  currency: z.string().describe("3-letter currency code, e.g. USD. Default to USD if not stated."),
  lineItems: z.array(LineItemSchema),
});

const client = new Anthropic();

export async function extractPOFromInvoice(pdfUrl: string, filename: string): Promise<ExtractedPO> {
  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 16000,
    system:
      "You extract structured purchase-order data from supplier invoice PDFs for a perfume resale business. " +
      "Read every line item table on the document, including items that span multiple pages. " +
      "Do not skip or summarize line items — one entry per line on the invoice. " +
      "If a field genuinely isn't present on the invoice, use an empty string (or 0 for numbers) rather than guessing a value that isn't there.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "url", url: pdfUrl },
            title: filename,
          },
          {
            type: "text",
            text: "Extract this supplier invoice into the structured PO format.",
          },
        ],
      },
    ],
    output_config: {
      format: zodOutputFormat(ExtractedPOSchema),
    },
  });

  if (!response.parsed_output) {
    throw new Error("Claude couldn't extract structured data from this PDF. Try a clearer scan, or enter the PO manually.");
  }

  return response.parsed_output;
}
