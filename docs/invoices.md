# Invoices in the app

## How invoices are stored

One store for every invoice, whatever brought it in (migration 0031):

| Table | What it holds |
|---|---|
| `ingredients` | the app's ingredient list. Started as a copy of MarginEdge's products (same ids); new ones get uuids |
| `vendors` | our vendors; `kind = 'garden'` for the garden; `me_vendor_id` while MarginEdge runs |
| `supplier_invoices` | every invoice: `source` is `photo`, `typed`, `garden` or `marginedge`; tax, delivery, other charges, total |
| `supplier_invoice_lines` | what was printed (code, description, quantity, unit price, total) and what it means (ingredient, `per_amount per_unit` one purchased unit holds, `per_base` when the importer worked it out, `priced`) |
| `vendor_item_matches` | this vendor's item → ingredient and how much one holds, learned from every confirmed line; keyed by the vendor's id, so a rename keeps it |
| `invoice_scans`, `invoice_scan_pages` | photos and what was read from them |
| `invoice_comparisons` | ours against MarginEdge's reading of the same invoice, line by line |

The model (`src/server/invoiceStore.ts`) reads vendors, invoices and price points from these
tables only; prices are the 60-day average of what came in, whatever the source.

### MarginEdge, while it runs

`src/server/meImport.ts` is the only code that reads MarginEdge. When its sync brings something
new, or an import answer changes how its export reads, it re-stores MarginEdge's invoices
(`source = 'marginedge'`), adds new products to `ingredients` and vendors to `vendors`, and
skips any invoice the app already has (photo or typed; same vendor and number, or same day and
total): those are compared into `invoice_comparisons` instead. Saving a photo of an invoice
MarginEdge already has does the same from the other side: ours is saved, the two are compared,
MarginEdge's copy is taken out. Either way an invoice counts once, as the copy a manager checked.

Taking MarginEdge out: delete `meImport.ts`, its sync and `invoice_comparisons`. The tables
above stay as they are.

## Next: a photo of an invoice

Same lines, filled in from a photo instead of typed, then checked by a manager before saving.

1. **Capture.** Take a photo on the iPad (or upload a PDF from email). Keep the image with the
   invoice (`app_invoices.photo`), so a question about a line can be checked against the paper.
2. **Read.** Send the image to a vision model with the vendor list and that vendor's past lines;
   ask for structured output: vendor, date, number, and per line description, quantity, unit,
   pack ("6/5 lb"), unit price, extension. Totals, tax, delivery and credits separately.
3. **Match.** Each line to an ingredient: first by the vendor's item code or description seen
   before (a table of `vendor + description → product, pack`, learned from every confirmed
   line), then by name. New lines are asked once, like the import answers now.
4. **Check.** Quantity × price = extension; lines + tax + charges = total; the price against the
   last one for that item (a jump over ~25% is shown, not blocked). Same checks the MarginEdge
   import runs (`lineMath`, `invoiceTotal`, `priceUnclear`).
5. **Confirm.** A manager reviews the read lines beside the photo, fixes anything, and saves.
   Nothing is priced until then.
6. **Credits and returns** as negative invoices against the original.

Open questions before building it: which model and its cost per invoice; how many invoices a
week (to size it); whether to keep MarginEdge for accounting exports or replace it entirely;
storage for the photos.
