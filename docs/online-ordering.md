# Online ordering (planned)

Agreed with the owner, Oct 6. Not built yet. Replaces the Square Online site (napolicarrboro.square.site). Square Online's own pacing, Busy Mode, prep time and pause controls have no public API, so this app owns them.

## 1. What stays with Square, what moves here

- **Square keeps:** the catalog (items, prices, modifiers, tax), card processing, payouts, refunds, and the sales record.
- **This app owns:** what is published online, the pickup windows and how full they are, the customer's order until it's paid, and the kitchen's view of it.
- **No payment gateway of our own.** Square's Web Payments SDK shows the card fields and turns the card into a one-time token in the customer's browser. The server only sends that token to Square's Payments API. Card numbers never touch this app.

## 2. Publishing the menu

The Menu screen gets an **Online** column. Nothing is online until a manager turns it on.

- **Per dish:** online on or off, the online description and photo (from Square at first), and **counts as a pizza** (on by default for the Pizza category).
- **Per modifier:** shown online or hidden. Gluten-sensitive crust and "fully cooked & sliced" are hidden.
- **Sold out tonight:** a one-tap 86 for online only, which resets the next day.
- **Freshness:** prices and items still come from Square. The catalog is refreshed when Square says it changed (catalog webhook), not only in the nightly sync, so a price change shows online within minutes.

## 3. Partially cooked, said plainly

Every online pizza is **partially cooked** and finished at home. True Neapolitan pizza is ruined within minutes if it is fully cooked and left in a box.

- The cooking choice is set to "partially cooked" automatically. Customers don't pick it.
- The message appears on the menu header, each pizza, the cart, and checkout, where the customer ticks a box to confirm they understand. It is also on the confirmation, with finishing instructions.
- Fully cooked pizzas and gluten-sensitive crust can be ordered in person to go, with a usual wait under 8 minutes. The site says so, with the phone number and address.

## 4. Pickup windows and pizza limits

- **Windows:** 20 minutes each, 5:00 to 9:00 pm, on the days we're open (12 a night).
- **Limit:** the maximum number of **pizzas** each window can take. Salads, gelato and drinks don't count.
- **Weekly plan:** a limit for each window on each weekday (Wednesday 5:00 to 5:20 → 4 pizzas, and so on). Managers edit it as a grid.
- **Date changes:** a different grid or "closed online" for one date (holidays, events, short-staffed).
- **Same day only.** Ordering opens in the morning for that evening.
- **Choosing a time:** the customer sees the windows that still have room for their pizzas, or takes "earliest available".
- **Too big for a window:** the order goes to the next window that can take all of it, the way Square does today. The earlier window stays open for smaller orders.
- **Bigger than any window:** an order with more pizzas than any single window allows can't be placed online. The site asks the customer to call.
- **Held at checkout:** the pizzas count against the window for a few minutes while the customer pays. The hold is released if they leave, which happens on about a third of checkouts today.
- **Tonight, from the kitchen:** a manager or the kitchen iPad can lower or close the remaining windows when dine-in gets busy. Paid orders are never moved without someone deciding to.

Later, possibly: have the app suggest tonight's limits from expected dine-in sales (the forecast already exists), or lower them on its own when dine-in tickets pile up.

## 5. The order, start to finish

1. The customer builds a cart from the published menu. The top of the menu shows the earliest pickup time, and the cart updates it as pizzas are added ("with 3 pizzas, earliest is 6:40"). The window is chosen at checkout, from the windows that fit the whole cart, so a time never has to be taken back.
2. The app checks the window still has room and holds the pizzas.
3. The app creates the Square order with Square item IDs and a pickup fulfillment (pickup time, customer name and phone). Square works out tax and the total.
4. The customer pays with card, Apple Pay or Google Pay through the Web Payments SDK. The server charges the token against that Square order, with an idempotency key so a retry never charges twice.
5. Once paid, the order is confirmed: email or text to the customer, and the order appears for the kitchen.
6. Because it's a normal Square pickup order, **existing ticket printing and Order Manager keep working**. The app marks it ready and picked up in Square, so Square's records stay accurate.
7. Refunds are made in Square. A webhook updates the order here.

Online orders arrive through the nightly sync like any other Square sale, so margins and reports count them automatically. They are told apart by their source.

## 6. Where it lives

- **Same repo and app (restaurant-ops), same Render service.** The public ordering page gets its own address, for example order.napolicarrboro.com. The new website can link to it now and embed it later.
- **Public routes** (no sign-in): the menu, window availability, start checkout, pay. They are rate-limited and expose only published items.
- **Square writes go through a new client** that can only create orders and payments and update fulfillments. The existing read-only client stays read-only.
- **Settings:** the Square application ID (public, for the card form), the webhook signature key, and a token with order and payment write permission, entered in Render like the existing secrets.
- **New tables:** online menu settings, the weekly window plan and date changes, online orders with their holds, and the checkout acknowledgment.

## 7. Before launch

- Test end to end in Square's sandbox, then with one real order refunded.
- Run alongside square.site for a night or two, then point "Order online" to the new page and turn off Square Online ordering.

## Open questions

- Text the customer when the order is ready? Today Square's ready texts never go out, because orders aren't marked ready in Square.
- Online tip presets, and whether to keep them at all.
