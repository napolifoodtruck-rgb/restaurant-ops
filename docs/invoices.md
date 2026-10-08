# Invoices in the app

## Now: typed in

`Orders › Invoices typed in` (and `🌱 Log a garden harvest`) records an invoice by hand: who it's
from, the day it came in, and lines of ingredient · how much · unit · total. Stored in
`app_invoices` / `app_invoice_lines` (migration 0028); vendors of our own in `vendors`
(`kind = 'garden'` for the garden).

They join MarginEdge's invoices in the model (`src/server/appInvoices.ts › appImport`), so
everything downstream treats them alike:

- **Prices:** an ingredient's price is the 60-day average of what came in. Garden lines are $0
  but count their quantity (`PricePoint.perBase`), so garden basil beside bought basil halves its
  price, and it goes back to the invoice price when the garden stops.
- **Checks:** a garden harvest counts as "bought" (no "ingredient not bought" flag); the garden is
  never a "vendor gone quiet".
- **Price source:** a recipe line shows `🌱 Our garden` and the date.
- **Orders:** $0 lines don't draft orders.

MarginEdge keeps reading the regular invoices. Nothing typed here is sent anywhere.

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
