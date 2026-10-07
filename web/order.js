// The customers' ordering page. Plain module, no build step, built with h() like the kitchen app
// so names from the menu can't inject markup. Phone first.
//
// Menu → item → cart → checkout (pickup time, name, phone, tip, "partially cooked" box) → card
// (Square's Web Payments SDK) → confirmation. The cart stays on this device until the order is paid.

const root = document.getElementById('order');

// What every online customer is told. Change the words here.
const PARTIAL_TITLE = 'Every online pizza is partially cooked.';
const PARTIAL_BODY = 'You finish it in your own oven at home, just before eating, so it tastes the way it does here. True Neapolitan pizza is ruined within minutes in a closed box.';
// Napoli's own instructions for finishing a partially cooked pizza at home.
const FINISH_STEPS = [
  'Preheat your oven to 450°F on convection, or higher.',
  'Once it’s preheated, put the pizza directly on the rack.',
  'Cook 3 to 6 minutes, depending on how crisp you like it.',
  'Add any finishing toppings.',
];
const IN_PERSON = 'Fully cooked pizzas and gluten-sensitive crust are in person only: come by or call, usually under 8 minutes.';
const TIPS = [0, 10, 15, 20];

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const show = (...nodes) => root.replaceChildren(...nodes.flat(Infinity).filter(Boolean));
const money = (cents) => `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
const money2 = (cents) => `$${(cents / 100).toFixed(2)}`;

async function api(method, path, body) {
  try {
    const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'No connection. Check your signal and try again.' } };
  }
}

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; } },
  set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let M = null;            // the menu, windows and payment settings
let brand = { name: null, logo: null };
// Cart lines: { key, variationId, quantity, optionIds }. Kept by day, so yesterday's cart doesn't come back.
let cart = [];
const saveCart = () => store.set('cart', { day: M?.today, lines: cart });

const variationOf = (id) => { for (const item of M.items) { const v = item.variations.find((x) => x.id === id); if (v) return { item, v }; } return null; };
const optionsOf = (item, ids) => item.optionLists.flatMap((l) => l.options.filter((o) => ids.includes(o.id)));
const linePrice = (l) => { const f = variationOf(l.variationId); return f ? (f.v.price + optionsOf(f.item, l.optionIds).reduce((s, o) => s + o.price, 0)) * l.quantity : 0; };
const cartPizzas = () => cart.reduce((s, l) => s + (variationOf(l.variationId)?.item.isPizza ? l.quantity : 0), 0);
const cartCount = () => cart.reduce((s, l) => s + l.quantity, 0);
const cartTotal = () => cart.reduce((s, l) => s + linePrice(l), 0);
/** Windows that can take an order of this many pizzas right now, first first. */
const fitting = (pizzas) => M.windows.filter((w) => w.open && w.left >= pizzas);

function header() {
  return h('header', { class: 'top' }, brand.logo ? h('img', { src: brand.logo, alt: brand.name ?? '' }) : h('div', { class: 'word', text: brand.name ?? M?.restaurant ?? '' }));
}
function partialNotice() {
  return h('div', { class: 'notice' }, h('b', { text: PARTIAL_TITLE }), ' ', PARTIAL_BODY, h('div', { class: 'small', style: 'margin-top:8px', text: IN_PERSON }));
}
function finishSteps() {
  return h('div', { class: 'card finish' }, h('div', { class: 'strong', text: 'Finishing at home' }), h('ol', {}, FINISH_STEPS.map((t) => h('li', { text: t }))));
}
function pickupLine() {
  const pizzas = Math.max(1, cartPizzas());
  if (M.paused) return h('div', { class: 'pickup closed' }, h('span', { class: 'strong', text: M.paused.until ? `We’re very busy right now. Online orders open again at ${M.paused.until.label}.` : 'We’ve stopped taking online orders for tonight.' }));
  if (!M.open) return h('div', { class: 'pickup closed' }, h('span', { class: 'strong', text: 'Online ordering is closed tonight.' }));
  const w = fitting(pizzas)[0];
  if (!w) {
    const most = Math.max(0, ...M.windows.map((x) => x.left));
    return h('div', { class: 'pickup closed' }, h('span', { class: 'strong', text: cartPizzas() > most && most > 0 ? `That’s more pizzas than we can take online for one pickup. Please call us.` : 'We’re full for online orders tonight.' }));
  }
  return h('div', { class: 'pickup' }, h('span', {}, 'Earliest pickup', cartPizzas() > 1 ? ` for ${cartPizzas()} pizzas` : ''), h('span', { class: 'strong', text: w.label }));
}
function cartBar() {
  if (!cart.length) return null;
  return h('div', { class: 'cartbar' }, h('button', { class: 'btn dark', onclick: cartView }, `View order · ${cartCount()} · ${money(cartTotal())}`));
}

// ------------------------------------------------------------------ menu

function menuView() {
  const cats = [...new Set(M.items.map((x) => x.category))];
  const slug = (c) => `cat-${c.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  show(header(), h('div', { class: 'wrap' },
    partialNotice(),
    pickupLine(),
    cats.length > 1 ? h('nav', { class: 'cats', 'aria-label': 'Menu sections' }, cats.map((c) => h('a', { href: `#${slug(c)}`, text: c }))) : null,
    M.items.length ? cats.map((c) => [h('h2', { id: slug(c), text: c }), h('div', { class: 'items' }, M.items.filter((x) => x.category === c).map(itemCard))])
      : h('p', { class: 'muted', text: 'The online menu isn’t up yet.' })),
    cartBar());
}

function itemCard(item) {
  const from = Math.min(...item.variations.map((v) => v.price));
  return h('button', { class: 'item', disabled: item.soldOut || !M.open ? true : undefined, onclick: () => itemSheet(item) },
    h('div', { class: 'grow' },
      h('div', { class: 'name' }, item.name, item.soldOut ? h('span', { class: 'tag out', text: 'Sold out tonight' }) : null),
      item.description ? h('div', { class: 'desc', text: item.description }) : null,
      item.notes.length ? h('div', { class: 'desc' }, item.notes.map((n) => h('span', { class: 'tag', style: 'margin:4px 6px 0 0', text: n }))) : null),
    h('div', { class: 'price', text: `${item.variations.length > 1 ? 'from ' : ''}${money(from)}` }),
    item.image ? h('img', { src: item.image, alt: '', loading: 'lazy' }) : null);
}

function closeSheet() { document.querySelector('.sheet-bg')?.remove(); }

function itemSheet(item, editing) {
  let variationId = editing?.variationId ?? item.variations[0].id;
  let quantity = editing?.quantity ?? 1;
  const picked = new Set(editing?.optionIds ?? []);
  const err = h('div', { class: 'error' });
  const total = () => (item.variations.find((v) => v.id === variationId).price + optionsOf(item, [...picked]).reduce((s, o) => s + o.price, 0)) * quantity;
  const addBtn = h('button', { class: 'btn dark wide' });
  const qtyText = h('span', { class: 'strong' });
  const refresh = () => { addBtn.textContent = `${editing ? 'Update' : 'Add'} · ${money(total())}`; qtyText.textContent = String(quantity); };
  const variations = item.variations.length > 1 ? h('fieldset', {}, h('legend', { text: 'Size' }), item.variations.map((v) => {
    const input = h('input', { type: 'radio', name: 'variation', value: v.id, checked: v.id === variationId ? true : undefined });
    input.addEventListener('change', () => { variationId = v.id; refresh(); });
    return h('label', { class: 'opt' }, input, h('span', { class: 'grow', text: v.name }), h('span', { text: money(v.price) }));
  })) : null;
  const lists = item.optionLists.map((list) => h('fieldset', {},
    h('legend', { text: `${list.name}${list.min ? ' (pick one)' : list.max && !list.single ? ` (up to ${list.max})` : ''}` }),
    list.options.map((o) => {
      const input = h('input', { type: list.single ? 'radio' : 'checkbox', name: list.id, value: o.id, checked: picked.has(o.id) ? true : undefined });
      input.addEventListener('change', () => {
        if (list.single) for (const x of list.options) picked.delete(x.id);
        input.checked ? picked.add(o.id) : picked.delete(o.id);
        refresh();
      });
      return h('label', { class: 'opt' }, input, h('span', { class: 'grow', text: o.name }), o.price ? h('span', { class: 'muted', text: `+${money(o.price)}` }) : null);
    })));
  addBtn.addEventListener('click', () => {
    for (const list of item.optionLists) {
      const n = list.options.filter((o) => picked.has(o.id)).length;
      if (n < list.min) return (err.textContent = `Pick ${list.name.toLowerCase().replace(/\?$/, '')}.`);
      if (list.max && !list.single && n > list.max) return (err.textContent = `Pick at most ${list.max} for ${list.name}.`);
    }
    const line = { key: editing?.key ?? `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, variationId, quantity, optionIds: [...picked] };
    cart = editing ? cart.map((l) => (l.key === editing.key ? line : l)) : [...cart, line];
    saveCart();
    closeSheet();
    editing ? cartView() : menuView();
  });
  const bg = h('div', { class: 'sheet-bg', onclick: (e) => e.target === bg && closeSheet() },
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': item.name },
      item.image ? h('img', { class: 'hero', src: item.image, alt: '' }) : null,
      h('div', { class: 'row' }, h('h3', { class: 'grow', text: item.name }), h('button', { class: 'link', text: 'Close', onclick: closeSheet })),
      item.description ? h('p', { class: 'muted small', text: item.description }) : null,
      item.notes.length ? h('p', { class: 'small' }, h('b', { text: item.notes.join(' · ') }), item.isPizza ? ' Finish it in your oven at home.' : '') : null,
      variations, lists,
      h('div', { class: 'qty' },
        h('button', { 'aria-label': 'One less', text: '−', onclick: () => { quantity = Math.max(1, quantity - 1); refresh(); } }), qtyText,
        h('button', { 'aria-label': 'One more', text: '+', onclick: () => { quantity = Math.min(20, quantity + 1); refresh(); } })),
      err, addBtn));
  refresh();
  closeSheet();
  document.body.append(bg);
}

// ------------------------------------------------------------------ cart and checkout

function lineView(l, actions = true) {
  const f = variationOf(l.variationId);
  if (!f) return null;
  const opts = optionsOf(f.item, l.optionIds).map((o) => o.name);
  return h('div', { class: 'line' },
    h('div', { class: 'row' }, h('span', { class: 'grow strong', text: `${l.quantity} × ${f.item.name}${f.item.variations.length > 1 ? ` (${f.v.name})` : ''}` }), h('span', { text: money(linePrice(l)) })),
    [...f.item.notes, ...opts].length ? h('div', { class: 'mods', text: [...f.item.notes, ...opts].join(', ') }) : null,
    actions ? h('div', { class: 'row', style: 'margin-top:6px; gap:16px' },
      h('button', { class: 'link', text: 'Change', onclick: () => itemSheet(f.item, l) }),
      h('button', { class: 'link', text: 'Remove', onclick: () => { cart = cart.filter((x) => x !== l); saveCart(); cart.length ? cartView() : menuView(); } })) : null);
}

/** `problem`: why the order couldn't go ahead (something just sold out), shown at the top. */
function cartView(problem) {
  closeSheet();
  const fits = fitting(cartPizzas());
  show(header(), h('div', { class: 'wrap' },
    h('button', { class: 'link', style: 'margin-top:16px', text: '← Back to the menu', onclick: menuView }),
    h('h1', { text: 'Your order' }),
    typeof problem === 'string' ? h('p', { class: 'error', role: 'alert', text: problem }) : null,
    h('div', { class: 'card' }, cart.map((l) => lineView(l)), h('div', { class: 'totals' }, h('div', { class: 'total' }, h('span', { text: 'Subtotal' }), h('span', { text: money2(cartTotal()) })))),
    pickupLine(),
    h('button', { class: 'btn dark wide', disabled: !fits.length ? true : undefined, text: 'Checkout', onclick: checkoutView })));
}

function checkoutView() {
  const fits = fitting(cartPizzas());
  const saved = store.get('customer') ?? {};
  const err = h('div', { class: 'error' });
  const when = h('select', { 'aria-label': 'Pickup time' }, fits.map((w, i) => h('option', { value: w.starts, text: `${w.label}${i === 0 ? ' (earliest)' : ''}` })));
  const name = h('input', { type: 'text', autocomplete: 'name', value: saved.name ?? '', required: true });
  const phone = h('input', { type: 'tel', autocomplete: 'tel', inputmode: 'tel', value: saved.phone ?? '', required: true });
  const email = h('input', { type: 'email', autocomplete: 'email', value: saved.email ?? '', placeholder: 'For your receipt (optional)' });
  let tipPct = 0;
  const tipRow = h('div', { class: 'tips' });
  const subtotal = cartTotal();
  const drawTips = () => tipRow.replaceChildren(...TIPS.map((p) => h('button', { type: 'button', class: p === tipPct ? 'on' : '', 'aria-pressed': String(p === tipPct), onclick: () => { tipPct = p; drawTips(); } },
    p ? h('div', {}, h('div', { class: 'strong', text: `${p}%` }), h('div', { class: 'small', text: money2(Math.round(subtotal * p / 100)) })) : 'No tip')));
  drawTips();
  const understood = h('input', { type: 'checkbox' });
  const go = h('button', { class: 'btn dark wide', text: 'Continue to payment' });
  go.addEventListener('click', async () => {
    err.textContent = '';
    if (!understood.checked) return (err.textContent = 'Please tick the box: the pizzas are partially cooked, to finish at home.');
    go.disabled = true;
    store.set('customer', { name: name.value, phone: phone.value, email: email.value });
    const r = await api('POST', '/api/order/checkout', {
      lines: cart.map((l) => ({ variationId: l.variationId, quantity: l.quantity, optionIds: l.optionIds })),
      window: when.value, name: name.value, phone: phone.value, email: email.value || undefined,
      tip: Math.round(subtotal * tipPct / 100), understood: true,
      // An order started earlier and not paid gives up its pickup slot to this one.
      replaces: store.get('pending') ?? undefined,
    });
    go.disabled = false;
    if (!r.ok) {
      err.textContent = r.data.error ?? 'Something went wrong. Try again, or call us.';
      if (r.status === 409) await refreshMenu();
      if (r.data.backToOrder) cartView(r.data.error);
      return;
    }
    store.set('pending', r.data.id);
    payView(r.data);
  });
  show(header(), h('div', { class: 'wrap' },
    h('button', { class: 'link', style: 'margin-top:16px', text: '← Your order', onclick: cartView }),
    h('h1', { text: 'Checkout' }),
    h('div', { class: 'card' },
      h('label', { class: 'field' }, 'Pickup time tonight', when),
      h('label', { class: 'field' }, 'Name for the order', name),
      h('label', { class: 'field' }, 'Phone', phone),
      h('label', { class: 'field' }, 'Email', email),
      h('div', { class: 'field strong small', style: 'margin-top:16px', text: 'Tip for the team' }), tipRow),
    finishSteps(),
    h('label', { class: 'ack' }, understood, h('span', {}, h('b', { text: 'I understand my pizzas are partially cooked' }), ' and I’ll finish them in my oven at home.')),
    err, go));
}

let squarePayments = null;
async function loadSquare() {
  if (squarePayments) return squarePayments;
  const p = M.payments;
  if (!p) throw new Error('Payments aren’t set up.');
  if (!window.Square) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = p.environment === 'production' ? 'https://web.squarecdn.com/v1/square.js' : 'https://sandbox.web.squarecdn.com/v1/square.js';
      s.onload = resolve; s.onerror = () => reject(new Error('The card form didn’t load.'));
      document.head.append(s);
    });
  }
  squarePayments = window.Square.payments(p.applicationId, p.locationId);
  return squarePayments;
}

async function payView(order) {
  const err = h('div', { class: 'error' });
  const pay = h('button', { class: 'btn dark wide', text: `Pay ${money2(order.total + order.tip)}`, disabled: true });
  const cardBox = h('div', { id: 'card-container' });
  show(header(), h('div', { class: 'wrap' },
    h('h1', { text: 'Payment' }),
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('span', { class: 'grow', text: `Pickup tonight at ${order.window.label}` }), h('span', { class: 'strong', text: order.name })),
      h('div', { class: 'totals', style: 'margin-top:12px' },
        h('div', {}, h('span', { text: 'Subtotal' }), h('span', { text: money2(order.subtotal) })),
        h('div', {}, h('span', { text: 'Tax' }), h('span', { text: money2(order.tax) })),
        order.tip ? h('div', {}, h('span', { text: 'Tip' }), h('span', { text: money2(order.tip) })) : null,
        h('div', { class: 'total' }, h('span', { text: 'Total' }), h('span', { text: money2(order.total + order.tip) })))),
    h('p', { class: 'small muted', text: `Your pickup time is held for ${order.holdMinutes} minutes while you pay.` }),
    cardBox, err, pay,
    h('button', { class: 'link', style: 'margin-top:16px', text: 'Change the order', onclick: changeOrder })));
  let card;
  try {
    const payments = await loadSquare();
    card = await payments.card();
    await card.attach('#card-container');
    pay.disabled = false;
  } catch (e) {
    err.textContent = `${e.message ?? 'The card form didn’t load.'} Please call us to order.`;
    return;
  }
  pay.addEventListener('click', async () => {
    err.textContent = '';
    pay.disabled = true;
    try {
      const t = await card.tokenize();
      if (t.status !== 'OK') { pay.disabled = false; return (err.textContent = t.errors?.[0]?.message ?? 'Check the card details.'); }
      let r = await api('POST', `/api/order/${order.id}/pay`, { sourceId: t.token });
      // The answer didn't come back (signal dropped) or a payment is still going through: see where the order stands before anything else.
      if (r.status === 0 || r.data.paying) r = await settled(order.id, r);
      if (r.data.backToOrder) { await refreshMenu().catch(() => {}); return cartView(`${r.data.error} You haven’t been charged.`); }
      if (!r.ok || r.data.status !== 'paid') { pay.disabled = false; return (err.textContent = r.data.error ?? 'The payment didn’t go through.'); }
      paid(r.data);
    } catch {
      const r = await settled(order.id, { ok: false, status: 0, data: {} });
      if (r.ok && r.data.status === 'paid') return paid(r.data);
      pay.disabled = false;
      err.textContent = 'We couldn’t reach the payment. Check your signal and try again: you won’t be charged twice.';
    }
  });
}

function paid(order) {
  cart = [];
  saveCart();
  store.set('pending', null);
  store.set('lastOrder', order.id);
  doneView(order);
}

/** Asks a few times whether the order got paid, while a payment may still be going through. */
async function settled(id, last) {
  for (let i = 0; i < 6; i++) {
    await new Promise((ok) => setTimeout(ok, 2000));
    const r = await api('GET', `/api/order/${id}`);
    if (r.ok && r.data.status === 'paid') return r;
  }
  return last.status === 0 ? { ok: false, status: 0, data: { error: 'We couldn’t reach the payment. Check your signal and try again: you won’t be charged twice.' } } : last;
}

/** Back from payment to change the order: its pickup slot isn't held twice. */
async function changeOrder() {
  const id = store.get('pending');
  if (id) { await api('POST', `/api/order/${id}/release`); store.set('pending', null); }
  await refreshMenu().catch(() => {});
  cartView();
}

function doneView(order) {
  show(header(), h('div', { class: 'wrap' },
    h('div', { class: 'done' },
      h('div', { class: 'big', text: 'Thank you' }),
      h('p', {}, `Your order is in. Pick it up tonight at `, h('b', { text: order.window.label }), ` under `, h('b', { text: order.name }), '.')),
    partialNotice(),
    finishSteps(),
    h('div', { class: 'card' }, order.lines.map((l) => h('div', { class: 'line' },
      h('div', { class: 'row' }, h('span', { class: 'grow strong', text: `${l.quantity} × ${l.name}` }), h('span', { text: money2(l.total) })),
      l.modifiers.length ? h('div', { class: 'mods', text: l.modifiers.map((m) => m.name).join(', ') }) : null)),
      h('div', { class: 'totals' }, h('div', { class: 'total' }, h('span', { text: 'Paid' }), h('span', { text: money2(order.total + order.tip) })))),
    order.receiptUrl ? h('p', {}, h('a', { href: order.receiptUrl, target: '_blank', rel: 'noopener', text: 'Your receipt' })) : null,
    h('button', { class: 'btn wide', text: 'Back to the menu', onclick: menuView })));
}

// ------------------------------------------------------------------ start

async function refreshMenu() {
  const r = await api('GET', '/api/order/menu');
  if (!r.ok) throw new Error(r.data.error ?? 'The menu didn’t load.');
  M = r.data;
  // Drop anything no longer on the menu (or sold out) from a saved cart.
  cart = cart.filter((l) => { const f = variationOf(l.variationId); return f && !f.item.soldOut; });
  saveCart();
}

async function start() {
  const b = await api('GET', '/api/brand');
  if (b.ok) brand = b.data;
  const saved = store.get('cart');
  if (Array.isArray(saved?.lines)) cart = saved.lines;
  try {
    await refreshMenu();
  } catch (e) {
    return show(h('div', { class: 'wrap' }, h('p', { class: 'error', text: `${e.message} Please call us to order.` })));
  }
  if (saved?.day !== M.today) { cart = []; saveCart(); }
  document.title = `${brand.name ?? M.restaurant} · Order online`;
  // Paid, but the page never heard back (signal dropped, page closed): show it's in rather than the cart.
  const pending = store.get('pending');
  if (pending) {
    const o = await api('GET', `/api/order/${pending}`);
    if (o.ok && o.data.status === 'paid') return paid(o.data);
    if (!o.ok || !['held', 'expired'].includes(o.data.status)) store.set('pending', null);
  }
  menuView();
}

start();
