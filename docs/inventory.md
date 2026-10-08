# Ingredient inventory (planned, after the chef demo)

Agreed with the owner, Oct 6. Not built yet.

## 1. Confirmed weights first

Every ingredient is weighed once on the scale. Two numbers are kept side by side:

- **Stated:** the pack size from the invoice or catalog, e.g. a #10 can of tomatoes at 6.4 lb.
- **Confirmed:** what it actually weighed, with who weighed it and when.

Until it's weighed, an ingredient shows **Needs a confirmed weight**, the same way a dish shows "Needs recipe".

- **Big gaps are flagged.** A large difference between stated and confirmed weight could be a vendor shorting a case, or a pack size logged wrong.
- **Drained vs net weight stays in the recipes.** We confirm the can as it arrives. The "strain tomatoes" recipe carries the loss through its yield.

## 2. Two layers, each with its own expected amount

- **Ingredients:** last count + deliveries − what went into prep − what was sold straight off the shelf.
  - Deliveries come from MarginEdge invoices.
  - "Went into prep" comes from prep check-offs, so the amount actually made must be recorded. Cooks need a quick "made 1½, not 2" when checking off.
  - "Sold straight off the shelf" covers dish and drink recipes that use an ingredient without prepping it (a ball of mozzarella, a bottle of wine).
- **Prep:** last count + made − what sales used. Sales trickle down one layer only. Prep is already counted nightly.
- **Prep made off-list:** a prep recipe that isn't on any list falls back to sales trickling down through it.

## 3. The weekly count

- **No MarginEdge counts.** We don't count in MarginEdge today, so there is nothing to import. This count is the only one.
- **The sheet:**
  - Grouped by where things are kept (walk-in, dry, freezer, bar), in shelf order.
  - Counted the way things are stored ("2 cases + 5 lb"), then converted to weight and dollars.
  - Open bar bottles are counted in tenths. No camera or slider.
- **The flag:** it fires while counting, when the gap is large in both percent and dollars.
- **The graph:** each ingredient gets a stock line, the same chart as prep stock. Deliveries step it up, use slopes it down, and the counts are dots.
- **Items with no recipe** (paper, cleaning, bar items with no recipe yet) are counted with no flag.

## 4. The long view (Ideas)

- **What it measures:** sales trickled all the way down to raw ingredients, measured from one count to another (about 4 weeks). This is actual food cost against theoretical, in dollars a month.
- **Why it's slow on purpose:** day-to-day timing noise cancels out, so nobody reacts to a one-week blip.
- **How it can mislead:** the fast layers and this one share the recipes. A wrong recipe can hide in both layers at once, so a growing long-run gap with calm weekly flags points at a recipe.

## 5. Likely cause, not just "off"

Every gap is matched against patterns, and the app says which one fits and why.

| Pattern | Likely cause |
| --- | --- |
| An ingredient gap and the prep made from it are off by opposite, matching amounts | A missed or wrong prep check-off |
| A prep gap that grows with sales of one dish | That dish's recipe, or portioning on the line |
| An ingredient gap that grows with how much prep is made | The prep recipe's amounts or yield |
| A gap that grows with deliveries, or a stated weight that was never confirmed | Pack weight wrong, or a vendor shorting |
| A one-time lump | An event: spoilage, a spill, a delivery not yet in MarginEdge |
| A count about a pack size off from expected (e.g. ×6 or ÷6) | Counted in the wrong unit (cases as lb) |
| A prep gap on items near the end of their shelf life | Spoilage: make less, or shift the par |
| More on hand than expected, steadily | The recipe overstates use, or an invoice was entered twice |

Each cause is repeated or ruled out over time. A cause that keeps showing up becomes an Ideas card, in dollars a month.

## Napoli's storage, in counting order (from the owner, Oct 8)

The weekly count is Saturday afternoon. The count sheet follows this order, top to bottom, shelf by shelf.

| Area | Shelf | What's there |
|---|---|---|
| Walk-in | Top | Vegetables |
| Walk-in | Second | Dairy, prepped items |
| Walk-in | Bottom | Meats |
| Walk-in | Floor | Kegs; bulk dough and balled dough |
| Walk-in freezer | | Gelato pans, gelato pints, frozen purées, frozen ground pork / ground beef / pork sausage, frozen prep (meatballs, lamb sausage) |
| Dry storage (prep area) | Bottom | Flour, sugar and dextrose bags; tomato can cases |
| Dry storage (prep area) | Second | Bulk bins: dextrose, nonfat milk, sugar, maltodextrin |
| Dry storage (prep area) | Third | Unrefrigerated veg: basil, cherry tomatoes, shallots |
| Dry storage (prep area) | Top | Pizza boxes |
| Kitchen shelf | | Oils, apricot purée, vinegars, spices |

Not mapped yet: the bar (bottles, fridges), and where paper and cleaning supplies live.

## Open question

- Count paper and cleaning supplies too, or only food and bar?
