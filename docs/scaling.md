# Before running more than one server

Today the app runs as a single server on Render. Some protections assume that, and need changing before a second server is added.

## One-at-a-time turns live in the server's memory

`src/server/turns.ts` (`inTurn`) makes saves to the same thing wait for each other. The queue lives inside one running server. Two servers would each have their own, so two people on different servers could clash again.

What uses it:

- **Kitchen book** (`inTurn('book')` in app.ts): recipe cards, answers, menu on/off, price variations. All of these are one stored value, so two saves at once could lose one.
- **Prep lists** (`list:<station>:<date>` in prep.ts): count, make, approve, done, check, start.
- **Station order** (`order:<station>` in prep.ts): the ↑↓ moves.
- **Draft purchase orders** (`order:<restaurant>:<vendor>:<delivery>` in orders.ts).

**The fix:** take the turn in PostgreSQL instead. Use `pg_advisory_xact_lock(hashtext(key))` inside a transaction, or `SELECT … FOR UPDATE` on the row being changed.

## Already safe on any number of servers

These are guarded in the database itself:

- **Login lockout:** counted in one UPDATE.
- **Purchase order status:** approve, sent, reopen and cancel each update only from the status they expect.
- **Plan apply:** the plan is claimed by its status before anything is added.
- **Weekday on/off:** a single UPDATE.

## Other things to check then

- **Caches kept in memory:**
  - The kitchen model in model.ts: `invalidate()` only clears the server it runs on.
  - Ideas in ideas.ts: held for 30 minutes.
  - Each server would show its own copy until these expire, so check that a change saved on one server shows up on the others.
- **Nightly syncs** (scheduler.ts) run inside the web app. Each server would start its own, so make sure the "already running today" check stops a second one.
