// The customers' ordering page. Plain module, no build step, built with h() like the kitchen app
// so names from the menu can't inject markup. Phone first.
//
// Menu → item → cart → checkout (pickup time, first and last name, phone, email, tip, "partially cooked" box) → card
// (Square's Web Payments SDK) → confirmation. The cart stays on this device until the order is paid.

const root = document.getElementById('order');

// What every online customer is told. Change the words here.
const PARTIAL_TITLE = 'Every online pizza is partially cooked.';
const PARTIAL_BODY = 'You finish it in your own oven at home, just before eating, so it tastes the way it does here. True Neapolitan pizza is ruined within minutes in a closed box.';
// Napoli's own instructions for finishing a partially cooked pizza at home.
// The confirmation email repeats these words (src/core/orderConfirmation.ts): change both.
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
const show = (...nodes) => { document.querySelector('.added')?.remove(); root.replaceChildren(...nodes.flat(Infinity).filter(Boolean)); };
const money = (cents) => `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
/** Square names carry kitchen shorthand ("++ Extra Mozzarella", "PARTIALLY COOKED (ONLY OPTION ONLINE)"):
 *  customers see the plain name. */
const tidy = (name) => {
  const s = String(name).replace(/\s*\((?:ONLY OPTION ONLINE|NOT AVAILABLE ONLINE)\)/gi, '').replace(/^[\s+*\-–—]+/, '').trim();
  return s === s.toUpperCase() && /[A-Z]/.test(s) ? s.charAt(0) + s.slice(1).toLowerCase() : s;
};
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

/** Links in the header, next to the cart, to Napoli's other pages. An entry without a link isn't shown. */
const NAV = [
  { label: 'Dine-in menu', href: 'https://docs.google.com/document/d/e/2PACX-1vTmda2AyQrnn4pn80SmYODyAiAZI8RBrkf8KBrw0YRi0DhI3WScfMk0IpMqtAJe-Kme3rzV5EVxJf9w/pub' },
  { label: 'Bar menu', href: 'https://docs.google.com/document/d/e/2PACX-1vTBHO8TAKIHUTjpcG9s6IV8OWiySw3W7g-XdMQl56ETFNibC6i_3b6Ri4-aqO3bwdRG6e_AXUdUIOvQ/pub' },
  // Square's own eGift card page for this account.
  { label: 'Gift cards', href: 'https://squareup.com/gift/7Y869N2QJ43W5/order' },
];
/** Where to send customers on a night this page isn't taking orders (the other ordering site runs those
 *  nights). Unset: no link. */
const OTHER_ORDERING = { label: 'Order on our other ordering page', href: 'https://napolicarrboro.square.site' };
/** A wide photo under the header, like the top of the Square Online site. Unset: no banner. */
const HEADER_IMAGE = null;
const BAG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 8h14l-1.2 12.1a1 1 0 0 1-1 .9H7.2a1 1 0 0 1-1-.9L5 8Z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/></svg>';

/** `wide`: the menu's width, so the logo lines up with the first item. `cart`: show the cart button
 *  (not while paying, when the way back is "Change the order"). */
function header({ wide = false, cart: withCart = true } = {}) {
  const links = NAV.filter((n) => n.href);
  const link = (n) => h('a', { href: n.href, target: '_blank', rel: 'noopener', text: n.label });
  const bag = withCart ? h('button', { type: 'button', class: 'bag', 'aria-label': `Your order, ${cartCount()} item${cartCount() === 1 ? '' : 's'}`, onclick: () => (cart.length ? cartView() : menuView()) }) : null;
  if (bag) { const icon = h('span', { class: 'icon' }); icon.innerHTML = BAG; bag.append(icon); if (cartCount()) bag.append(h('span', { class: 'count', text: String(cartCount()) })); }
  return [
    h('header', { class: 'top' },
      h('div', { class: `top-in${wide ? ' wide' : ''}` },
        h('a', { class: 'brand', href: '/order', 'aria-label': `${brand.name ?? M?.restaurant ?? ''} online ordering` },
          brand.logo ? h('img', { src: brand.logo, alt: brand.name ?? '' }) : h('span', { class: 'word', text: brand.name ?? M?.restaurant ?? '' })),
        links.length ? h('nav', { class: 'site', 'aria-label': 'Napoli' }, links.map(link)) : null,
        links.length ? h('details', { class: 'site-menu' }, h('summary', { 'aria-label': 'More pages', text: '☰' }), h('div', { class: 'drop' }, links.map(link))) : null,
        bag)),
    HEADER_IMAGE && wide ? h('div', { class: 'banner' }, h('img', { src: HEADER_IMAGE, alt: '' })) : null,
  ];
}
function partialNotice() {
  return h('div', { class: 'notice' }, h('b', { text: PARTIAL_TITLE }), ' ', PARTIAL_BODY, h('div', { class: 'small', style: 'margin-top:8px', text: IN_PERSON }));
}
function finishSteps() {
  return h('div', { class: 'card finish' }, h('div', { class: 'strong', text: 'Finishing at home' }), h('ol', {}, FINISH_STEPS.map((t) => h('li', { text: t }))));
}
// Pickup: ASAP (the earliest window that fits the order) or a time picked for later. Kept for the day.
const laterPick = () => { const p = store.get('pickup'); return p?.day === M.today ? p.starts : null; };
const setLater = (starts) => store.set('pickup', starts ? { day: M.today, starts } : null);
/** The window this order will be picked up in, or null when nothing fits. A later time that no longer
 *  has room moves to the next one that does. */
function pickupWindow() {
  const fits = fitting(Math.max(1, cartPizzas()));
  const later = fits.length > 1 ? laterPick() : null;
  return (later && (fits.find((w) => w.starts >= later) ?? fits.at(-1))) || fits[0] || null;
}
function pickupLine() {
  const box = h('div');
  const draw = () => box.replaceChildren(pickupChoice(draw));
  draw();
  box.redraw = draw;
  return box;
}
function pickupChoice(redraw) {
  const pizzas = Math.max(1, cartPizzas());
  const elsewhere = () => OTHER_ORDERING.href ? h('a', { class: 'elsewhere', href: OTHER_ORDERING.href, text: OTHER_ORDERING.label }) : null;
  if (M.paused) return h('div', { class: 'pickup closed' }, h('span', { class: 'strong', text: M.paused.off ? 'We’re not taking online orders right now.' : M.paused.until ? `We’re very busy right now. Online orders open again at ${M.paused.until.label}.` : 'We’ve stopped taking online orders for tonight.' }), M.paused.until ? null : elsewhere());
  if (!M.open) return h('div', { class: 'pickup closed' }, h('span', { class: 'strong', text: 'Online ordering is closed tonight.' }), elsewhere());
  const w = fitting(pizzas)[0];
  if (!w) {
    const most = Math.max(0, ...M.windows.map((x) => x.left));
    return h('div', { class: 'pickup closed' }, h('span', { class: 'strong', text: cartPizzas() > most && most > 0 ? `That’s more pizzas than we can take online for one pickup. Please call us.` : 'We’re full for online orders tonight.' }));
  }
  const fits = fitting(pizzas);
  const later = fits.length > 1 ? laterPick() : null;
  const chosen = pickupWindow();
  const moved = later && chosen.starts !== later;
  if (moved) setLater(chosen.starts); // say it once, then it's the new pick
  const pick = (starts) => { setLater(starts); redraw(); };
  const tab = (on, label, sub, onclick) => h('button', { type: 'button', class: on ? 'on' : '', 'aria-pressed': String(on), onclick },
    h('div', { class: 'strong', text: label }), h('div', { class: 'small', text: sub }));
  return h('div', { class: 'pickup choose' },
    h('div', { class: 'small muted', text: `Pickup tonight${cartPizzas() > 1 ? ` · ${cartPizzas()} pizzas` : ''}` }),
    h('div', { class: 'when' },
      tab(!later, 'ASAP', w.label, () => pick(null)),
      fits.length > 1 ? tab(!!later, 'Schedule for later', later ? chosen.label : 'Pick a time', () => pick(later ?? fits[1].starts)) : null),
    later ? h('div', { class: 'times', role: 'group', 'aria-label': 'Pickup time' }, fits.slice(1).map((x) => h('button', {
      type: 'button', class: x.starts === chosen.starts ? 'on' : '', 'aria-pressed': String(x.starts === chosen.starts), text: x.label, onclick: () => pick(x.starts) }))) : null,
    moved ? h('div', { class: 'small', text: `${M.windows.find((x) => x.starts === later)?.label ?? 'That time'} has no room for this order anymore, so we moved it to ${chosen.label}.` }) : null);
}

// ------------------------------------------------------------------ menu

function menuView() {
  const cats = [...new Set(M.items.map((x) => x.category))];
  const slug = (c) => `cat-${c.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  show(header({ wide: true }), h('div', { class: 'wrap menu' },
    partialNotice(),
    pickupLine(),
    cats.length > 1 ? h('nav', { class: 'cats', 'aria-label': 'Menu sections' }, cats.map((c) => h('a', { href: `#${slug(c)}`, text: c }))) : null,
    M.items.length ? cats.map((c) => [h('h2', { id: slug(c), text: c }), h('div', { class: 'items' }, M.items.filter((x) => x.category === c).map(itemCard))])
      : h('p', { class: 'muted', text: 'The online menu isn’t up yet.' })));
  followSections();
}
/** Underline the section being read in the sticky section bar. */
function followSections() {
  const links = [...document.querySelectorAll('.cats a')];
  if (!links.length || !('IntersectionObserver' in window)) return;
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) {
      for (const a of links) a.classList.toggle('on', a.getAttribute('href') === `#${e.target.id}`);
      document.querySelector('.cats a.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, { rootMargin: '-150px 0px -65% 0px' });
  for (const a of links) { const sec = document.querySelector(a.getAttribute('href')); if (sec) seen.observe(sec); }
}

function itemCard(item) {
  const from = Math.min(...item.variations.map((v) => v.price));
  const off = item.soldOut || !M.open;
  return h('button', { class: 'item', disabled: off ? true : undefined, onclick: () => itemSheet(item) },
    h('div', { class: 'grow' },
      h('div', { class: 'name', text: item.name }),
      item.description ? h('div', { class: 'desc', text: item.description }) : null,
      h('div', { class: 'meta' },
        h('span', { class: 'price', text: `${item.variations.length > 1 ? 'from ' : ''}${money(from)}` }),
        item.soldOut ? h('span', { class: 'tag out', text: 'Sold out tonight' }) : item.notes.map((n) => h('span', { class: 'tag', text: tidy(n) })))),
    h('div', { class: 'pic' }, item.image ? h('img', { src: item.image, alt: '', loading: 'lazy' }) : null,
      off ? null : h('span', { class: 'plus', 'aria-hidden': 'true', text: '+' })));
}

function closeSheet() { document.querySelector('.sheet-bg')?.remove(); document.body.classList.remove('locked'); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

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
      return h('label', { class: 'opt' }, input, h('span', { class: 'grow', text: tidy(o.name) }), o.price ? h('span', { class: 'muted', text: `+${money(o.price)}` }) : null);
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
    editing ? cartView() : (menuView(), addedPreview(line));
  });
  const bg = h('div', { class: 'sheet-bg', onclick: (e) => e.target === bg && closeSheet() },
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': item.name },
      item.image ? h('img', { class: 'hero', src: item.image, alt: '' }) : null,
      h('button', { class: 'sheet-close', 'aria-label': 'Close', text: '×', onclick: closeSheet }),
      h('div', { class: 'sheet-body' },
        h('h3', { text: item.name }),
        item.description ? h('p', { class: 'muted', text: item.description }) : null,
        item.notes.length ? h('p', { class: 'note' }, h('b', { text: item.notes.map(tidy).join(' · ') }), item.isPizza ? '. Finish it in your oven at home.' : '') : null,
        variations, lists),
      h('div', { class: 'sheet-foot' }, err,
        h('div', { class: 'row' },
          h('div', { class: 'qty' },
            h('button', { 'aria-label': 'One less', text: '−', onclick: () => { quantity = Math.max(1, quantity - 1); refresh(); } }), qtyText,
            h('button', { 'aria-label': 'One more', text: '+', onclick: () => { quantity = Math.min(20, quantity + 1); refresh(); } })),
          addBtn))));
  refresh();
  closeSheet();
  document.body.append(bg);
  document.body.classList.add('locked');
  bg.querySelector('.sheet-close').focus({ preventScroll: true });
}

// ------------------------------------------------------------------ cart and checkout

/** "Added to your order": a peek at the cart, top right, that goes away by itself. */
function addedPreview(line) {
  const close = () => { clearTimeout(timer); box.remove(); };
  const box = h('div', { class: 'added', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'row' }, h('span', { class: 'grow strong', text: '✓ Added to your order' }), h('button', { class: 'link', 'aria-label': 'Close', text: 'Close', onclick: () => close() })),
    lineView(line, false),
    h('div', { class: 'row small muted', style: 'margin:8px 0 12px' }, h('span', { class: 'grow', text: `${cartCount()} item${cartCount() === 1 ? '' : 's'} in your order` }), h('span', { text: money2(cartTotal()) })),
    h('button', { class: 'btn dark wide', text: 'View order', onclick: () => cartView() }));
  let timer = setTimeout(close, 5000);
  // Stays put while the customer is reading or about to tap it.
  box.addEventListener('pointerenter', () => clearTimeout(timer));
  box.addEventListener('pointerleave', () => { clearTimeout(timer); timer = setTimeout(close, 3000); });
  box.addEventListener('focusin', () => clearTimeout(timer));
  document.body.append(box);
}
function lineView(l, actions = true) {
  const f = variationOf(l.variationId);
  if (!f) return null;
  const opts = optionsOf(f.item, l.optionIds).map((o) => tidy(o.name));
  return h('div', { class: 'line' },
    h('div', { class: 'row' }, h('span', { class: 'grow strong', text: `${l.quantity} × ${f.item.name}${f.item.variations.length > 1 ? ` (${f.v.name})` : ''}` }), h('span', { text: money(linePrice(l)) })),
    [...f.item.notes, ...opts].length ? h('div', { class: 'mods', text: [...f.item.notes.map(tidy), ...opts].join(', ') }) : null,
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
  const pickup = pickupLine();
  const saved = store.get('customer') ?? {};
  const err = h('div', { class: 'error' });
  // Saved before first and last name were asked for: one `name`.
  const [savedFirst = '', ...savedLast] = saved.firstName === undefined ? String(saved.name ?? '').trim().split(/\s+/) : [saved.firstName, saved.lastName ?? ''];
  const firstName = h('input', { type: 'text', autocomplete: 'given-name', value: savedFirst, required: true });
  const lastName = h('input', { type: 'text', autocomplete: 'family-name', value: savedLast.join(' '), required: true });
  const phone = h('input', { type: 'tel', autocomplete: 'tel', inputmode: 'tel', value: saved.phone ?? '', required: true });
  const email = h('input', { type: 'email', autocomplete: 'email', value: saved.email ?? '', placeholder: 'Your confirmation goes here', required: true });
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
    if (!pickupWindow()) return (err.textContent = 'We’re full for online orders tonight.');
    if (!firstName.value.trim() || !lastName.value.trim()) return (err.textContent = 'Your first and last name, please.');
    if (!email.value.trim()) return (err.textContent = 'Your email, for your order confirmation.');
    go.disabled = true;
    store.set('customer', { firstName: firstName.value, lastName: lastName.value, phone: phone.value, email: email.value });
    const r = await api('POST', '/api/order/checkout', {
      lines: cart.map((l) => ({ variationId: l.variationId, quantity: l.quantity, optionIds: l.optionIds })),
      window: pickupWindow()?.starts, firstName: firstName.value, lastName: lastName.value, phone: phone.value, email: email.value,
      tip: Math.round(subtotal * tipPct / 100), understood: true,
      // An order started earlier and not paid gives up its pickup slot to this one.
      replaces: store.get('pending') ?? undefined,
    });
    go.disabled = false;
    if (!r.ok) {
      err.textContent = r.data.error ?? 'Something went wrong. Try again, or call us.';
      if (r.status === 409) { await refreshMenu(); pickup.redraw(); }
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
      pickup,
      h('div', { class: 'pair' }, h('label', { class: 'field' }, 'First name', firstName), h('label', { class: 'field' }, 'Last name', lastName)),
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
  show(header({ cart: false }), h('div', { class: 'wrap' },
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
  store.set('pickup', null);
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
      l.modifiers.length ? h('div', { class: 'mods', text: l.modifiers.map((m) => tidy(m.name)).join(', ') }) : null)),
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
