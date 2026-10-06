// The web app. Plain modules, no build step. Every screen is built with h() from data the
// API returns, never from HTML strings, so names and messages can't inject markup.

const app = document.getElementById('app');

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

const ICONS = {
  today: 'M4 4h16v16H4z M8.5 12.5l2.5 2.5 4.5-5',
  prep: 'M5 4h14v17H5z M9 4h6v3H9z M9 12h6 M9 16h4',
  menu: 'M5 5h14 M5 10h14 M5 15h9 M5 20h6',
  recipes: 'M4 5.5C6.5 4.5 9.5 4.5 12 6c2.5-1.5 5.5-1.5 8-.5V19c-2.5-1-5.5-1-8 .5-2.5-1.5-5.5-1.5-8-.5z M12 6v13.5',
  margins: 'M4 20V4 M4 20h16 M8 16v-4 M12 16V8 M16 16v-6',
  orders: 'M3 7h11v9H3z M14 10h4l3 3v3h-7',
  reports: 'M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h5',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19 12h2 M3 12h2 M12 3v2 M12 19v2 M17 7l1.5-1.5 M5.5 18.5L7 17 M17 17l1.5 1.5 M5.5 5.5L7 7',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '22'); svg.setAttribute('height', '22'); svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

// What was just pressed: while the request it started is out, that button shows a spinner,
// and a thin bar runs along the top. Requests nobody pressed for (refreshes) stay quiet.
let pressed = null, pressedAt = 0, waiting = 0, barTimer;
const notePress = (el) => { if (el) { pressed = el; pressedAt = Date.now(); } };
document.addEventListener('click', (e) => notePress(e.target.closest?.('button, a, summary')), true);
document.addEventListener('change', (e) => notePress(e.target.closest?.('select, input')), true);
/** Marks a button as working: disabled, with a small spinner beside its label. */
function busy(el, on) {
  if (!el) return;
  el.classList.toggle('busy', on);
  if (on) { el.dataset.wasDisabled = el.disabled ? '1' : ''; el.disabled = true; el.setAttribute('aria-busy', 'true'); }
  else { el.disabled = el.dataset.wasDisabled === '1'; el.removeAttribute('aria-busy'); }
}
function working(on) {
  waiting = Math.max(0, waiting + (on ? 1 : -1));
  clearTimeout(barTimer);
  if (waiting) barTimer = setTimeout(() => document.body.classList.add('working'), 120);
  else document.body.classList.remove('working');
}

async function api(method, path, body) {
  const el = pressed && Date.now() - pressedAt < 500 && pressed.isConnected && !pressed.classList.contains('busy') ? pressed : null;
  if (el) { pressed = null; busy(el, true); working(true); }
  try {
    const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    let data = {};
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'No connection. Check the wifi and try again.' } };
  } finally {
    if (el) { working(false); if (el.isConnected) busy(el, false); }
  }
}

/** Replace an element's children, skipping empty slots (null, false, nested arrays flattened). */
function fill(el, ...kids) { el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)); }
// A screen redrawn after something done on it (an answer, a check-off) stays where you were:
// no fading, no bar, the same scroll position.
// Several can be saving at once (answer one line, then the next, without waiting): the page
// refreshes once, after the last of them, so nothing still saving is redrawn under you.
let inPlace = false, actionsOut = 0, lastRefresh = null, waitingRefresh = null;
function show(...nodes) {
  const y = window.scrollY, keep = inPlace;
  inPlace = false;
  if (keep && actionsOut > 0) { waitingRefresh = lastRefresh; return; }
  fill(app, ...nodes);
  if (keep) window.scrollTo(0, y);
}
/** Redraws a screen in place: call it after an action on that screen succeeds. */
function refreshInPlace(draw) {
  lastRefresh = draw;
  if (actionsOut > 0) { waitingRefresh = draw; return; }
  inPlace = true;
  return draw();
}
/** An action on the page (a save): while any are out, refreshes wait; the last one to finish runs the latest. */
const tabNow = () => app.querySelector('.shell')?.dataset.active;
async function pageAction(fn) {
  const tab = tabNow();
  actionsOut++;
  try { return await fn(); } finally {
    actionsOut--;
    // Gone to another tab meanwhile: the save still counts, but don't pull them back to redraw this one.
    if (!actionsOut && waitingRefresh) { const r = waitingRefresh; waitingRefresh = null; if (tabNow() === tab) refreshInPlace(r); }
  }
}
/** The line someone just answered folds away; the rest of the page stays put. */
function foldAway(row) {
  if (!row) return Promise.resolve();
  row.style.height = `${row.offsetHeight}px`;
  row.classList.add('leaving');
  requestAnimationFrame(() => { row.style.height = '0px'; });
  return new Promise((done) => setTimeout(() => { row.remove(); done(); }, 220));
}

/**
 * The page formula, on every screen: the work in the middle, things to glance at in boxes
 * down the right. Narrow screens stack the boxes under the work (or above it, sideFirst).
 */
function page(main, side, opts = {}) {
  const boxes = [side].flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
  const middle = h('div', { class: 'page-main' }, main);
  if (!boxes.length) return h('div', { class: 'page solo' }, middle);
  return h('div', { class: `page${opts.sideFirst ? ' side-first' : ''}` }, middle,
    h('aside', { class: 'page-side', 'aria-label': opts.label ?? 'At a glance' }, boxes));
}
/** A box for the right column: a small heading, then what it holds. */
function sideBox(title, ...body) {
  return h('section', { class: 'card tight' }, title ? h('div', { class: 'small muted strong', text: title }) : null, ...body);
}
/** A box with one number that matters, and a line under it. */
function statBox(title, value, ...under) {
  return sideBox(title, h('div', { class: 'big', text: value }), ...under);
}
/** Buttons stacked full width in a side box. */
const sideActions = (...buttons) => h('div', { class: 'side-actions' }, buttons);
/** A thin progress bar: done of total. */
function progress(done, total) {
  const bar = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done) }, h('div'));
  bar.firstChild.style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;
  return bar;
}

const ACCESS_NAMES = { staff: 'Staff', manager: 'Manager', admin: 'Administrator', owner: 'Account owner' };
const canAdminister = (me) => me.access === 'owner' || me.access === 'admin';
const AREA_NAMES = { kitchen: 'Kitchen', bar: 'Bar', both: 'Kitchen and bar', none: 'Neither' };
/** The side of the menu showing: the one picked last, else where this person works. */
const sideOf = (me) => me.side ?? (me.area === 'bar' ? 'bar' : 'kitchen');
function sideSwitch(me, redraw) {
  const side = sideOf(me);
  return h('div', { class: 'seg', role: 'group', 'aria-label': 'Kitchen or bar' },
    ['kitchen', 'bar'].map((a) => h('button', { class: side === a ? 'on' : '', 'aria-pressed': String(side === a), text: AREA_NAMES[a], onclick: () => { me.side = a; redraw(); } })));
}
const LEVELS = ['line', 'lead', 'sous', 'chef', 'manager', 'owner'];
const atLeast = (level, needed) => LEVELS.indexOf(level) >= LEVELS.indexOf(needed);

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ------------------------------------------------------------------ start

/** The restaurant's own look: its name and logo (set under Settings). */
let BRAND = { name: null, logo: null };
async function loadBrand() {
  const r = await api('GET', '/api/brand');
  if (r.ok) BRAND = r.data;
  if (BRAND.name) document.title = `${BRAND.name} · Kitchen`;
}
/** The logo, white on black, or the name set in a frame the same way when there's no logo yet. */
function brandMark(size = 'rail') {
  if (BRAND.logo) return h('img', { class: `brand-logo ${size}`, src: BRAND.logo, alt: BRAND.name ?? 'Logo' });
  return h('div', { class: `brand-word ${size}`, text: (BRAND.name ?? 'Kitchen').toUpperCase() });
}

/** Sign-in screens: the restaurant's mark on black, the form beneath. */
function stage(...children) {
  return h('div', { class: 'center' }, h('div', { class: 'stage' }, brandMark('stage'), ...children));
}

/** Square's photo of a dish, square-cropped; nothing when there isn't one. */
function photo(url, cls = 'thumb') {
  if (!url) return null;
  const img = h('img', { class: cls, src: url, alt: '', loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => img.remove());
  return img;
}

async function start() {
  if (!BRAND.name) await loadBrand();
  const invite = location.hash.match(/^#invite=([A-Za-z0-9_-]+)$/);
  if (invite) return inviteScreen(invite[1]);
  const me = await api('GET', '/api/me');
  // On a kitchen iPad that belongs to a station, everyone lands on that station's prep.
  // Cooks, and anyone on a kitchen iPad, land on Prep: on an iPad that belongs to a station, that station's list.
  if (me.ok) {
    const who = { ...me.data.me, ...(me.data.device ? { device: me.data.device } : {}) };
    return who.device || !atLeast(who.roleLevel, 'manager') ? prepHome(who) : todayScreen(who);
  }
  const device = await api('GET', '/api/devices/staff');
  if (device.ok) return pinNames(device.data);
  const setup = await api('GET', '/api/setup');
  if (setup.ok && setup.data.open) return setupScreen();
  return emailSignIn();
}

// ------------------------------------------------------------------ first-time setup

function setupScreen() {
  const err = h('div', { class: 'error', role: 'alert' });
  const form = h('form', { class: 'panel', onsubmit: async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const button = form.querySelector('button[type=submit]');
      button.disabled = true;
      const r = await api('POST', '/api/setup', Object.fromEntries(f));
      button.disabled = false;
      if (!r.ok) return (err.textContent = r.data.error ?? 'That didn’t work.');
      home(r.data.me);
    } },
    h('div', {}, h('div', { class: 'kicker', text: 'First-time setup' }), h('h1', { text: 'Set up your restaurant' }),
      h('div', { class: 'sub', text: 'You’ll be the owner. Your team comes in from Square once it’s connected.' })),
    h('label', {}, 'Restaurant name', h('input', { type: 'text', name: 'restaurantName', required: true, autocomplete: 'organization' })),
    h('label', {}, 'Your name', h('input', { type: 'text', name: 'name', required: true, autocomplete: 'name' })),
    h('label', {}, 'Your email', h('input', { type: 'email', name: 'email', required: true, autocomplete: 'email' })),
    h('label', {}, 'Password (10 characters or more)', h('input', { type: 'password', name: 'password', required: true, minlength: '10', autocomplete: 'new-password' })),
    h('label', {}, 'Setup code', h('input', { type: 'password', name: 'token', required: true, autocomplete: 'off' }),
      h('span', { class: 'small muted', text: 'In Render: your web service → Environment → SETUP_TOKEN.' })),
    err,
    h('button', { class: 'btn dark', type: 'submit', text: 'Create and sign in' }),
  );
  show(stage(form));
}

// ------------------------------------------------------------------ manager sign-in

function emailSignIn(backToPins) {
  const err = h('div', { class: 'error', role: 'alert' });
  const form = h('form', { class: 'panel', onsubmit: async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const r = await api('POST', '/api/login/password', f);
      if (!r.ok) return (err.textContent = r.data.error ?? 'That didn’t work.');
      start();
    } },
    h('div', {}, h('h1', { text: 'Sign in' }), h('div', { class: 'sub', text: 'Managers and owners. Kitchen iPads use names and PINs once a manager sets them up.' })),
    h('label', {}, 'Email', h('input', { type: 'email', name: 'email', required: true, autocomplete: 'username' })),
    h('label', {}, 'Password', h('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password' })),
    err,
    h('button', { class: 'btn dark', type: 'submit', text: 'Sign in' }),
    backToPins ? h('button', { class: 'link', type: 'button', onclick: start, text: '← Back to names' }) : null,
  );
  show(stage(form));
}

// ------------------------------------------------------------------ invite: set a password

async function inviteScreen(token) {
  const r = await api('GET', `/api/invites/${token}`);
  const leave = () => { history.replaceState(null, '', '/'); start(); };
  if (!r.ok) {
    return show(stage(h('div', { class: 'panel' },
      h('h1', { text: 'Invite' }), h('div', { class: 'error', text: r.data.error ?? 'This link isn’t valid.' }),
      h('button', { class: 'btn', onclick: leave, text: 'Go to sign in' }))));
  }
  const err = h('div', { class: 'error', role: 'alert' });
  const form = h('form', { class: 'panel', onsubmit: async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      if (f.password !== f.again) return (err.textContent = 'The two passwords don’t match.');
      const s = await api('POST', `/api/invites/${token}`, { password: f.password });
      if (!s.ok) return (err.textContent = s.data.error ?? 'That didn’t work.');
      leave();
    } },
    h('div', {}, h('div', { class: 'kicker', text: r.data.restaurantName }), h('h1', { text: `Welcome, ${r.data.name}` }),
      h('div', { class: 'sub', text: 'Choose a password. From now on you sign in with your email and this password, on any phone or computer.' })),
    h('label', {}, 'Email', h('input', { type: 'email', name: 'email', value: r.data.email, readonly: true, autocomplete: 'username' })),
    h('label', {}, 'Password (10 characters or more)', h('input', { type: 'password', name: 'password', required: true, minlength: '10', autocomplete: 'new-password' })),
    h('label', {}, 'Same password again', h('input', { type: 'password', name: 'again', required: true, minlength: '10', autocomplete: 'new-password' })),
    err,
    h('button', { class: 'btn dark', type: 'submit', text: 'Set password and sign in' }),
  );
  show(stage(form));
}

// ------------------------------------------------------------------ kitchen iPad: name, then PIN

function pinNames({ device, staff }) {
  const withPin = staff.filter((s) => s.hasPin);
  show(stage(h('div', { class: 'names-wrap' },
    h('div', { class: 'kicker', text: device }),
    h('h1', { text: 'Who’s working?' }),
    h('div', { class: 'sub', text: withPin.length ? 'Tap your name.' : 'No one has a PIN yet. A manager can set PINs under Settings.' }),
    h('div', { class: 'names', style: undefined }, withPin.map((s) => h('button', { onclick: () => pinPad(s, device) }, s.name))),
    h('button', { class: 'link', onclick: () => emailSignIn(true), text: 'Manager sign in with email' }),
  )));
}

function pinPad(person, device) {
  let pin = '';
  const dots = h('div', { class: 'dots', 'aria-label': 'PIN entered' });
  const err = h('div', { class: 'error', role: 'alert' });
  const draw = () => fill(dots, ...Array.from({ length: Math.max(4, pin.length) }, (_, i) => h('span', { class: i < pin.length ? 'on' : '' })));
  const press = (d) => { if (pin.length < 6) { pin += d; err.textContent = ''; draw(); } };
  const go = async () => {
    if (pin.length < 4) return (err.textContent = 'At least 4 digits.');
    const r = await api('POST', '/api/login/pin', { staffId: person.id, pin });
    pin = ''; draw();
    if (!r.ok) return (err.textContent = r.data.error ?? 'That didn’t work.');
    start();
  };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => h('button', { onclick: () => press(d), text: d }));
  draw();
  show(stage(h('div', { class: 'panel' },
    h('div', {}, h('div', { class: 'kicker', text: device }), h('h1', { text: person.name }), h('div', { class: 'sub', text: 'Enter your PIN.' })),
    dots, err,
    h('div', { class: 'pinpad' }, keys,
      h('button', { onclick: () => { pin = pin.slice(0, -1); draw(); }, 'aria-label': 'Delete', text: '⌫' }),
      h('button', { onclick: () => press('0'), text: '0' }),
      h('button', { class: 'go', onclick: go, text: 'Go' })),
    h('button', { class: 'link', onclick: start, text: '← Not you?' }),
  )));
}

// ------------------------------------------------------------------ signed in


function shell(me, active, content) {
  const manager = atLeast(me.roleLevel, 'manager');
  const nav = [
    ['today', 'Today', todayScreen], ['prep', 'Prep', prepHome], ['recipes', 'Recipes', recipesScreen], ['menu', 'Menu', manager && menuScreen], ['margins', 'Performance', manager && marginsScreen], ['reports', 'Reports', manager && reportsScreen], ['orders', 'Orders', manager && ordersScreen],
  ];
  return h('div', { class: 'shell', 'data-active': active },
    h('nav', { class: 'rail', 'aria-label': 'Main' },
      h('div', { class: 'logo' }, brandMark('rail')),
      nav.map(([key, label, go]) => h('button', { class: active === key ? 'on' : '', 'data-key': key, disabled: !go, title: go ? label : 'Coming next', onclick: go ? () => go(me) : undefined }, icon(key), label)),
      h('button', { class: active === 'settings' ? 'on' : '', 'data-key': 'settings', onclick: () => home(me) }, icon('settings'), 'Settings'),
    ),
    h('main', {}, content),
  );
}

/**
 * While a screen loads: if a page is already up, it stays, faded, with the new tab marked and the bar running
 * along the top, until the new one replaces it. Only the very first screen starts from a blank page.
 */
function loadingScreen(me, active, title) {
  if (inPlace) return;
  const current = app.querySelector('.shell');
  if (current) {
    current.querySelector('main')?.classList.add('stale');
    current.querySelectorAll('.rail > button').forEach((b) => b.classList.toggle('on', b.dataset.key === active));
    working(true);
    // Whatever shows next ends the wait.
    const stop = new MutationObserver(() => { if (!current.isConnected) { working(false); stop.disconnect(); } });
    stop.observe(app, { childList: true });
    return;
  }
  show(shell(me, active, [h('header', {}, h('h1', { text: title })), h('p', { class: 'muted', text: 'Working it out…' })]));
}

const dollars = (v, opts = {}) => (Math.abs(v) >= 10000 && !opts.exact ? `$${(v / 1000).toFixed(1)}k` : `$${v.toLocaleString(undefined, { minimumFractionDigits: opts.cents ? 2 : 0, maximumFractionDigits: opts.cents ? 2 : 0 })}`);
const pct = (v) => (v === undefined || v === null ? '–' : `${(v * 100).toFixed(1)}%`);
/** A date, with its year when it isn't this year. */
const dateWithYear = (d) => (d.slice(0, 4) === String(new Date().getFullYear()) ? shortDate(d) : new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
const shortDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function missingNote(missing) {
  if (!missing?.length) return null;
  const words = { square: 'Square sales (press Sync now on the Square box in Settings)', marginedge: 'MarginEdge invoices (Sync now on the MarginEdge box)', recipeCards: 'recipes (Import the kitchen-book file in Settings)' };
  return h('div', { class: 'note', text: `Still needed for complete numbers: ${missing.map((m) => words[m] ?? m).join('; ')}.` });
}

// ------------------------------------------------------------------ margins

/** A small line of weekly values; gaps where the dish wasn't on the menu. */
function sparkline(series, direction) {
  const W = 96, H = 30, P = 3;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', `spark ${direction}`);
  svg.setAttribute('aria-hidden', 'true');
  const vals = series.filter((v) => v !== null);
  if (!vals.length) return svg;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const x = (i) => P + (series.length > 1 ? (i / (series.length - 1)) * (W - 2 * P) : (W - 2 * P) / 2);
  const y = (v) => (hi === lo ? H / 2 : H - P - ((v - lo) / (hi - lo)) * (H - 2 * P));
  let run = [];
  const flush = () => {
    if (run.length > 1) { const pl = document.createElementNS(ns, 'polyline'); pl.setAttribute('points', run.join(' ')); svg.append(pl); }
    if (run.length === 1) { const c = document.createElementNS(ns, 'circle'); const [cx, cy] = run[0].split(','); c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', '2'); svg.append(c); }
    run = [];
  };
  series.forEach((v, i) => { if (v === null) flush(); else run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`); });
  flush();
  // The latest week, marked.
  const lastIdx = series.length - 1 - [...series].reverse().findIndex((v) => v !== null);
  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('cx', x(lastIdx)); dot.setAttribute('cy', y(series[lastIdx])); dot.setAttribute('r', '2.5'); dot.setAttribute('class', 'last');
  svg.append(dot);
  return svg;
}

function trendCell(t) {
  if (!t) return h('div');
  const c = t.change;
  const dir = c === undefined ? 'flat' : c >= 0.05 ? 'up' : c <= -0.05 ? 'down' : 'flat';
  const label = c === undefined ? 'too new' : dir === 'flat' ? 'steady' : `${dir === 'up' ? '▲' : '▼'} ${Math.abs(Math.round(c * 100))}%`;
  return h('div', { class: 'trend', title: `Plates per open day, week by week${t.partial ? '; gaps are weeks it wasn’t on the menu' : ''}` },
    sparkline(t.series, dir), h('div', { class: `small trend-${dir}`, text: label }), t.partial ? h('div', { class: 'small muted', text: 'part of period' }) : null);
}

const ROLE = { earner: ['Top earner', 'ok'], sellMore: ['Sell more', 'blue'], minor: ['Small', ''] };

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function presetRanges() {
  const now = new Date();
  const back = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return iso(d); };
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthEnd = new Date(firstOfMonth); lastMonthEnd.setDate(0);
  const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
  return [
    ['Last 7 days', { from: back(6), to: iso(now) }],
    ['Last 30 days', { from: back(29), to: iso(now) }],
    ['Last 90 days', null],
    ['This month', { from: iso(firstOfMonth), to: iso(now) }],
    [lastMonthStart.toLocaleDateString(undefined, { month: 'long' }), { from: iso(lastMonthStart), to: iso(lastMonthEnd) }],
  ];
}

/**
 * Across the top of Performance: which category, which period, table or charts. Filters sit
 * in one place above what they filter.
 */
function perfToolbar(me, state, m, current, again, mode) {
  const same = (a, b) => (!a && !b) || (a && b && a.from === b.from && a.to === b.to);
  const names = [...m.categories.map((c) => c.name), ...(m.salesOnly ?? []).map((c) => c.name)];
  const seg = (label, options, cls = '') => h('div', { class: `seg ${cls}`, role: 'group', 'aria-label': label },
    options.map(([text, on, go]) => h('button', { class: on ? 'on' : '', 'aria-pressed': String(on), text, onclick: go })));
  // The presets as the period dropdown wants them: a key, a label, and the dates (90 days is the default, no dates).
  const presets = presetRanges().map(([label, r]) => [label, label, r ?? { from: m.from, to: m.to }]);
  const chosen = presetRanges().find(([, r]) => same(r, state.range));
  return h('section', { class: 'card toolbar one-row' },
    names.length > 1 ? seg('Category', names.map((n) => [n, n === current, () => again({ category: n })]), 'wrap-seg') : null,
    periodPicker(presets, chosen ? chosen[0] : 'custom', { from: m.from, to: m.to }, (key, r) => {
      const preset = presetRanges().find(([label]) => label === key);
      marginsScreen(me, { ...state, range: key === 'custom' ? r : preset?.[1] ?? null });
    }),
    mode ? h('div', { class: 'tool-end' }, seg('Table or charts', [['Table', mode !== 'charts', () => again({ mode: 'table' })], ['Charts', mode === 'charts', () => again({ mode: 'charts' })]])) : null);
}

/**
 * Who brings in the money, as a share: a donut of the five biggest and everyone else, with the
 * numbers beside it (a donut alone is for a glance; the list is for reading).
 */
/** A donut of shares (the top five and Other), with a legend. Same as a drill-down chart with nothing below. */
function shareDonut(items, { format, total }) {
  return drillDonut({ title: total, format, items });
}

/**
 * The one clickable pie for the whole app. A layer is { title (what the middle totals), crumb (its name in the
 * trail), format, items: [{ name, value, open?() → layer (or a promise of one), go?() }], note? }.
 * Click a slice (or its legend line) to go a layer down; the middle shows the way back up, and the trail
 * under the chart jumps to any layer above. Other opens into the items it grouped.
 */
function drillDonut(root) {
  if (!root.items.some((x) => x.value > 0)) return null;
  const box = h('div', { class: 'drill' });
  const stack = [root];
  const draw = () => fill(box, drawLayer());
  const enter = async (next, row) => {
    if (row) row.classList.add('loading');
    const layer = await next;
    if (!layer || !layer.items?.some((x) => x.value > 0)) { if (row) { row.classList.remove('loading'); row.append(h('span', { class: 'small muted', text: ' · nothing below this' })); } return; }
    stack.push(layer);
    draw();
    box.querySelector('.donut-back')?.focus();
  };
  const back = (to = stack.length - 2) => { if (to < 0) return; stack.length = to + 1; draw(); };
  function drawLayer() {
    const node = stack[stack.length - 1];
    const format = node.format ?? stack[0].format;
    const sorted = node.items.filter((x) => x.value > 0).sort((p, q) => q.value - p.value);
    if (!sorted.length) return null;
    const top = sorted.length > 6 ? sorted.slice(0, 5) : sorted;
    const rest = sorted.slice(top.length);
    const parts = [...top.map((x, i) => ({ ...x, color: SERIES[i] })),
      ...(rest.length ? [{ name: `Other (${rest.length})`, value: rest.reduce((a, x) => a + x.value, 0), color: OTHER, open: () => ({ title: node.title, crumb: 'Other', format, items: rest }) }] : [])];
    const total = parts.reduce((a, x) => a + x.value, 0);
    const R = 74, r = 48, C = 80;
    const svg = s('svg', { viewBox: '0 0 160 160', class: 'donut', role: 'img', 'aria-label': parts.map((x) => `${x.name} ${Math.round((x.value / total) * 100)}%`).join(', ') });
    const deep = stack.length > 1;
    const centre = h('div', { class: `donut-centre${deep ? ' can-back' : ''}` });
    const showCentre = (title, value, sub) => fill(centre,
      deep ? h('button', { class: 'donut-back', 'aria-label': `Back to ${stack[stack.length - 2].crumb ?? 'the start'}`, onclick: () => back() }, `‹ ${stack[stack.length - 2].crumb ?? 'Back'}`) : null,
      h('div', { class: 'donut-big', text: value }), h('div', { class: 'small muted', text: title }), sub ? h('div', { class: 'small muted', text: sub }) : null);
    const reset = () => showCentre(node.title, format(total));
    const point = (rad, a) => [C + rad * Math.sin(a), C - rad * Math.cos(a)];
    let a0 = 0;
    const can = (x) => Boolean(x.open || x.go);
    const pick = (x, row) => (x.go ? x.go() : x.open ? enter(Promise.resolve(x.open()).then((l) => l && { crumb: x.name, ...l }), row) : null);
    const marks = parts.map((x) => {
      const a1 = a0 + (x.value / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const end = Math.min(a1, a0 + Math.PI * 2 - 1e-4);
      const [x0, y0] = point(R, a0), [x1, y1] = point(R, end), [x2, y2] = point(r, end), [x3, y3] = point(r, a0);
      const path = s('path', { d: `M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r},${r} 0 ${large} 0 ${x3},${y3} Z`, fill: x.color, class: `slice${can(x) ? ' can-open' : ''}`, tabindex: 0, role: can(x) ? 'button' : 'img', 'aria-label': `${x.name}, ${format(x.value)}${can(x) ? ': open' : ''}` });
      a0 = a1;
      return path;
    });
    marks.forEach((m) => svg.append(m));
    // The hole goes back up a layer.
    if (deep) { const hole = s('circle', { cx: C, cy: C, r: r - 2, class: 'donut-hole' }); hole.addEventListener('click', () => back()); svg.append(hole); }
    const share = (x) => `${Math.round((x.value / total) * 100)}%`;
    const legendRows = parts.map((x, i) => {
      const key = h('span', { class: 'cov-key' }); key.style.background = x.color;
      const row = h(can(x) ? 'button' : 'div', { class: `donut-row${can(x) ? ' can-open' : ''}` }, key,
        h('span', { class: 'grow', text: x.name, title: x.name }), h('b', { text: share(x) }), h('span', { class: 'small muted', text: format(x.value) }), can(x) ? h('span', { class: 'chev', text: '›' }) : null);
      const on = () => { marks.forEach((m, j) => m.classList.toggle('dim', j !== i)); legendRows.forEach((l, j) => l.classList.toggle('on', j === i)); showCentre(x.name, share(x), format(x.value)); };
      const off = () => { marks.forEach((m) => m.classList.remove('dim')); legendRows.forEach((l) => l.classList.remove('on')); reset(); };
      for (const el of [row, marks[i]]) { el.addEventListener('pointerenter', on); el.addEventListener('pointerleave', off); }
      marks[i].addEventListener('focus', on); marks[i].addEventListener('blur', off);
      if (can(x)) {
        row.addEventListener('click', () => pick(x, row));
        marks[i].addEventListener('click', () => pick(x, row));
        marks[i].addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(x, row); } });
      }
      return row;
    });
    reset();
    const trail = deep ? h('nav', { class: 'donut-trail', 'aria-label': 'Layers' }, stack.map((l, i) => [i ? h('span', { class: 'muted', text: ' › ' }) : null,
      i === stack.length - 1 ? h('b', { text: l.crumb ?? 'All' }) : h('button', { class: 'linkish', text: l.crumb ?? 'All', onclick: () => back(i) })])) : null;
    return [trail, h('div', { class: 'donut-wrap' }, svg, centre), h('div', { class: 'donut-legend' }, legendRows), node.note ?? null,
      !deep && parts.some(can) ? h('div', { class: 'small muted', text: 'Click a slice to go a layer deeper; the middle brings you back.' }) : null];
  }
  draw();
  return box;
}

/** A dish or drink a layer down: full price against each discount day, or the dish itself against each paid add-on (free changes listed under). */
async function breakdownLayer(m, query) {
  const r = await api('GET', `/api/costs/breakdown?${query}&from=${m.from}&to=${m.to}`);
  if (!r.ok) return null;
  const d = r.data;
  const free = d.free?.length ? h('div', { class: 'small' }, h('div', { class: 'small muted strong', text: 'Free changes (no charge)' }),
    h('div', { class: 'list compact' }, d.free.map((f) => h('div', {}, h('span', { class: 'grow', text: f.name }), h('span', { class: 'small muted', text: `${f.uses.toLocaleString()}×` }))))) : null;
  if (d.versions?.length) return { title: 'sales', format: dollars, items: d.versions.map((v) => ({ name: `${v.name} (${v.quantity.toLocaleString()} sold)`, value: v.value })), note: free };
  if (!d.addOns.length && !free) return null;
  return { title: 'sales', format: dollars, items: [{ name: `${d.name} itself`, value: d.base }, ...d.addOns.map((a) => ({ name: `${a.name} (${a.uses.toLocaleString()}×)`, value: a.value }))], note: free };
}

/** Which dishes are picking up or slowing down: plates a day, the latest weeks against the earlier ones. */
function moversBox(dishes, word) {
  const live = dishes.filter((d) => !d.offSince && d.trend?.change !== undefined);
  const up = live.filter((d) => d.trend.change >= 0.05).sort((a, b) => b.trend.change - a.trend.change).slice(0, 3);
  const down = live.filter((d) => d.trend.change <= -0.05).sort((a, b) => a.trend.change - b.trend.change).slice(0, 3);
  if (!up.length && !down.length) return null;
  const row = (d, cls, arrow) => h('div', {}, h('span', { class: 'grow', text: d.name }), sparkline(d.trend.series, cls === 'trend-up' ? 'up' : 'down'), h('b', { class: cls, text: `${arrow} ${Math.abs(Math.round(d.trend.change * 100))}%` }));
  return sideBox('Picking up and slowing down',
    h('div', { class: 'list compact movers' }, up.map((d) => row(d, 'trend-up', '▲')), down.map((d) => row(d, 'trend-down', '▼'))),
    h('div', { class: 'small muted', text: `${word} a day, recent weeks against earlier ones in the period.` }));
}

// Sortable columns: what each sorts by, and which way a first click goes.
const MARGIN_COLUMNS = [
  { key: 'name', label: 'Dish', value: (d) => d.name.toLowerCase(), first: 'asc' },
  { key: 'plate', label: 'One plate: food | gross profit', value: (d) => d.leftPerPlate, first: 'desc' },
  { key: 'sold', label: 'Sold', value: (d, view) => (view === 'day' ? d.soldPerDay ?? 0 : d.sold), first: 'desc', num: true },
  { key: 'left', label: (view) => (view === 'day' ? 'Est. gross profit per day on the menu' : 'Est. gross profit, all of them'), value: (d, view) => (view === 'day' ? d.leftPerDay ?? 0 : d.leftTotal), first: 'desc' },
  { key: 'trend', label: 'Trend, plates a day', value: (d) => (d.trend?.change ?? null), first: 'desc' },
];

async function marginsScreen(me, state = {}) {
  state = { view: 'total', sort: { key: 'left', dir: 'desc' }, ...state };
  loadingScreen(me, 'margins', 'Menu Performance');
  const r = await api('GET', `/api/margins?area=${sideOf(me)}${state.range ? `&from=${state.range.from}&to=${state.range.to}` : ''}`);
  if (!r.ok) return show(shell(me, 'margins', [h('h1', { text: 'Menu Performance' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  renderMargins(me, state, r.data);
}

function renderMargins(me, state, m) {
  const salesCat = m.salesOnly?.find((c) => c.name === state.category) ?? (!m.categories.length ? m.salesOnly?.[0] : undefined);
  if (salesCat) return renderSalesOnly(me, state, m, salesCat);
  const cat = m.categories.find((c) => c.name === state.category) ?? m.categories[0];
  const again = (changes) => renderMargins(me, { ...state, ...changes }, m);
  const start = m.dataFrom && m.dataFrom > m.from ? m.dataFrom : m.from;
  const days = Math.round((Date.parse(m.to) - Date.parse(start)) / 86400000) + 1;
  const early = m.dataFrom && m.from < m.dataFrom ? h('div', { class: 'note', text: `Sales are stored from ${shortDate(m.dataFrom)}, so this period starts there.` }) : null;
  const bar = sideOf(me) === 'bar';
  const header = performanceHeader(me, state, `${cat ? cat.name + ' · ' : ''}${shortDate(m.from)} – ${shortDate(m.to)}`, `Prices from Square, costs from MarginEdge, priced as of ${shortDate(m.to)}.`);
  const toolbar = perfToolbar(me, { ...state, category: cat?.name }, m, cat?.name, again, state.mode ?? 'table');
  const whole = statBox(`${AREA_NAMES[sideOf(me)]} · estimated gross profit`, dollars(m.totals.leftOver),
    h('div', { class: 'small muted', text: `${days} days · ${bar ? 'pour' : 'food'} cost ${pct(m.totals.foodCostShare)} on ${bar ? 'drinks' : 'dishes'} with recipes` }));
  if (!cat) return show(shell(me, 'margins', [header, toolbar, page([missingNote(m.missing), h('div', { class: 'card small muted', text: 'No dishes with recipes sold in this period.' })], [whole])]));

  const perDay = state.view === 'day';
  const column = MARGIN_COLUMNS.find((c) => c.key === state.sort.key) ?? MARGIN_COLUMNS.find((c) => c.key === 'left');
  const sign = state.sort.dir === 'asc' ? 1 : -1;
  const dishes = [...cat.dishes].sort((a, b) => {
    const x = column.value(a, state.view), y = column.value(b, state.view);
    if (x === null && y === null) return 0;
    if (x === null) return 1; // no value (too new for a trend) always last
    if (y === null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * sign;
  });
  const maxPrice = Math.max(...dishes.map((d) => d.averagePrice), 1);
  const maxValue = Math.max(...dishes.map((d) => (perDay ? d.leftPerDay ?? 0 : d.leftTotal)), 1);
  const partOfPeriod = (d) => d.daysOn && d.daysOn < m.openDays;
  const rows = dishes.map((d) => {
    // Bars take a share of their column, so they fit however wide the middle is.
    const plate = h('div', { class: 'pricebar' }, h('div', { class: 'food' }), h('div', { class: 'left' }));
    plate.style.width = `calc((100% - 56px) * ${(d.averagePrice / maxPrice).toFixed(4)})`;
    plate.firstChild.style.width = `${Math.min(100, (d.plateCost / d.averagePrice) * 100).toFixed(2)}%`;
    const [roleText, roleCls] = ROLE[d.role] ?? ['', ''];
    const value = perDay ? d.leftPerDay ?? 0 : d.leftTotal;
    const other = perDay ? `${dollars(d.leftTotal)} in all` : d.leftPerDay !== undefined ? `${dollars(d.leftPerDay)} a day` : '';
    const note = d.offSince ? `off the menu since ${shortDate(d.offSince)}` : partOfPeriod(d) ? `on the menu ${d.daysOn} of ${m.openDays} days, since ${shortDate(d.firstSold)}` : null;
    const opened = state.open?.includes(d.name);
    // Roles judge money over the whole period; in the per-day view, a dish that joined partway is just marked new.
    const role = d.offSince ? null : perDay ? (partOfPeriod(d) ? h('span', { class: 'tag blue', text: 'New' }) : null) : roleText ? h('span', { class: `tag ${roleCls}`, text: roleText }) : null;
    const row = h('div', { class: `mrow${d.offSince ? ' off' : ''}` },
      h('div', { class: 'name-cell' }, h('button', { class: 'name linkish', 'aria-expanded': opened ? 'true' : 'false', title: 'Show the plate, ingredient by ingredient', onclick: () => again({ open: opened ? state.open.filter((n) => n !== d.name) : [...(state.open ?? []), d.name] }) }, d.name, h('span', { class: 'muted', text: opened ? ' ▾' : ' ▸' })), note ? h('div', { class: 'small muted', text: note }) : null, role),
      h('div', { class: 'plate-cell' }, h('div', { class: 'row tight' }, plate, h('span', { class: 'small muted', text: `${dollars(d.averagePrice, { cents: true })}` })),
        h('div', { class: 'small', text: `${dollars(d.plateCost, { cents: true })}${d.estimated ? '*' : ''} food · ${dollars(d.leftPerPlate, { cents: true })} profit` })),
      h('div', { class: 'num' }, h('div', { text: d.sold.toLocaleString() }), d.soldPerDay !== undefined ? h('div', { class: 'small muted', text: `${d.soldPerDay}/day` }) : null),
      h('div', {}, h('div', { class: 'row tight' }, (() => { const t = h('div', { class: 'total' }); t.style.width = `calc((100% - 64px) * ${(Math.max(0, value) / maxValue).toFixed(4)})`; return t; })(), h('b', { text: dollars(value) })), other ? h('div', { class: 'small muted', text: other }) : null),
      trendCell(d.trend),
    );
    return opened ? [row, plateDetail(d)] : row;
  });
  const headCell = (c) => {
    const active = c.key === column.key;
    const label = typeof c.label === 'function' ? c.label(state.view) : c.label;
    return h('button', {
      class: `sort${active ? ' on' : ''}${c.num ? ' num' : ''}`,
      'aria-sort': active ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
      onclick: () => again({ sort: { key: c.key, dir: active ? (state.sort.dir === 'asc' ? 'desc' : 'asc') : c.first } }),
    }, label, h('span', { class: 'arrow', text: active ? (state.sort.dir === 'asc' ? ' ▲' : ' ▼') : '' }));
  };
  const seg = (label, options) => h('div', { class: 'seg', role: 'group', 'aria-label': label },
    options.map(([text, on, go]) => h('button', { class: on ? 'on' : '', 'aria-pressed': String(on), text, onclick: go })));
  const charts = state.mode === 'charts';
  const catLeft = cat.dishes.reduce((a, d) => a + d.leftTotal, 0);
  const fc = (cat.weeklyFoodCost ?? []).map((v) => (v === null ? null : v));
  const summary = statBox(`${cat.name} · estimated gross profit`, dollars(catLeft),
    h('div', { class: 'small muted', text: `${bar ? 'Pour' : 'Food'} cost ${pct(cat.foodCostShare)} · ${cat.dishes.length} ${bar ? 'drinks' : 'dishes'} · ${days} days` }),
    fc.some((v) => v !== null) ? h('div', { class: 'row tight' }, h('span', { class: 'small muted', text: `${bar ? 'Pour' : 'Food'} cost by week` }), sparkline(fc, 'flat')) : null,
    h('div', { class: 'small muted', text: `Whole ${sideOf(me)} menu: ${dollars(m.totals.leftOver)} estimated gross profit, ${pct(m.totals.foodCostShare)} ${bar ? 'pour' : 'food'} cost.` }),
    h('div', { class: 'small muted', text: `Sales minus each recipe’s ${bar ? 'pour' : 'food'} cost at today’s invoice prices. Waste, comps and labor aren’t in it.` }));
  const noCard = cat.noCard.length ? sideBox(`Selling with no recipe · ${dollars(cat.noCardSales)} not counted`,
    h('div', { class: 'list compact' }, cat.noCard.slice(0, 6).map((x) => h('div', {}, h('span', { class: 'grow', text: x.name }), h('span', { class: 'small muted', text: dollars(x.netSales) })))),
    h('button', { class: 'btn small-btn', text: 'See what’s missing', onclick: () => coverageScreen(me) })) : null;
  const donut = drillDonut({ title: 'gross profit', crumb: cat.name, format: dollars, items: cat.dishes.map((d) => ({ name: d.name, value: d.leftTotal, open: () => breakdownLayer(m, `recipeId=${encodeURIComponent(d.recipeId)}`) })) });
  const split = donut ? sideBox(`Gross profit by ${bar ? 'drink' : 'dish'}`, donut,
    h('div', { class: 'small muted', text: `Share of ${cat.name.toLowerCase()}’s estimated gross profit in the period. A layer down: what that ${bar ? 'drink' : 'dish'} sold, by add-on${bar ? ' or discount day' : ''}.` })) : null;
  const side = [summary, split, moversBox(cat.dishes, bar ? 'Drinks' : 'Plates'), noCard];
  if (charts) return show(shell(me, 'margins', [header, toolbar, page([early, missingNote(m.missing), ...chartsView(state, cat, m, again)], side)]));
  const table = h('section', { class: 'card' },
    h('div', { class: 'row wrap' }, h('div', { class: 'grow small muted', text: perDay ? 'Per open day each dish was on the menu: fair to new dishes and specials. Click a dish for its plate, or a column title to sort.' : 'Across every plate sold in the period. Click a dish for its plate, or a column title to sort.' }),
      seg('Estimated gross profit', [['All of it', !perDay, () => again({ view: 'total' })], ['Per day on the menu', perDay, () => again({ view: 'day' })]])),
    h('div', { class: 'mrow head', role: 'row' }, MARGIN_COLUMNS.map(headCell)),
    rows,
    h('div', { class: 'small muted', text: 'Price is what guests paid on average, after discounts. * part of the recipe still uses an estimated price. Top earners together bring in 80% of the money in the period. Trend: plates per open day, week by week; weeks off the menu are left out.' }),
  );
  show(shell(me, 'margins', [header, toolbar, page([early, missingNote(m.missing), table], side)]));
}

function performanceHeader(me, state, kicker, sub) {
  return h('header', { class: 'row wrap' },
    h('div', { class: 'grow' }, h('div', { class: 'kicker', text: kicker }), h('h1', { text: 'Menu Performance' }), h('div', { class: 'sub', text: sub })),
    sideSwitch(me, () => marginsScreen(me, { ...state, category: undefined })));
}


/** Categories with sales but no costs yet (drinks, until they're linked to what they pour from). */
function renderSalesOnly(me, state, m, cat) {
  const again = (changes) => renderMargins(me, { ...state, ...changes }, m);
  const sortKey = state.salesSort ?? 'netSales';
  const cols = [['name', 'Item'], ['sold', 'Sold'], ['soldPerDay', 'Per day on'], ['averagePrice', 'Avg price'], ['netSales', 'Sales'], ['salesPerDay', 'Sales per day on']];
  const items = [...cat.items].sort((a, b) => (sortKey === 'name' ? a.name.localeCompare(b.name) : b[sortKey] - a[sortKey]));
  const max = Math.max(...items.map((i) => i[sortKey === 'salesPerDay' ? 'salesPerDay' : 'netSales']), 1);
  const bar = (v) => { const b = h('div', { class: 'total' }); b.style.width = `${Math.max(2, (v / max) * 140)}px`; return b; };
  const perDayView = sortKey === 'salesPerDay';
  const header = performanceHeader(me, state, `${cat.name} · ${shortDate(m.from)} – ${shortDate(m.to)}`, `Sales from Square. Costs come once each ${sideOf(me) === 'bar' ? 'drink has a recipe: the pour from the bottle or keg, or the cocktail’s spec' : 'item has a recipe'}.`);
  const table = h('section', { class: 'card' },
    h('div', { class: 'srow head' }, cols.map(([k, label]) => h('button', { class: `sort${sortKey === k ? ' on' : ''}${k === 'name' ? '' : ' num'}`, text: label + (sortKey === k ? ' ▼' : ''), onclick: () => again({ salesSort: k }) }))),
    items.map((i) => h('div', { class: `srow${i.offSince ? ' off' : ''}` },
      h('div', {}, h('div', { class: 'name', text: i.name }), i.offSince ? h('div', { class: 'small muted', text: `last sold ${shortDate(i.offSince)}` }) : i.daysOn < m.openDays ? h('div', { class: 'small muted', text: `on ${i.daysOn} of ${m.openDays} days` }) : null),
      h('div', { class: 'num', text: qty(i.sold) }),
      h('div', { class: 'num small muted', text: `${i.soldPerDay}/day` }),
      h('div', { class: 'num', text: dollars(i.averagePrice, { cents: true }) }),
      h('div', { class: 'row tight num-end' }, perDayView ? null : bar(i.netSales), h('b', { text: dollars(i.netSales) })),
      h('div', { class: 'row tight num-end' }, perDayView ? bar(i.salesPerDay) : null, h('span', { text: dollars(i.salesPerDay) })))),
    h('div', { class: 'small muted', text: 'Per day on: open days from an item’s first sale to its last (or today, if it’s still selling), so a new bottle or a seasonal cocktail is compared fairly.' }));
  const sold = cat.items.reduce((a, i) => a + i.sold, 0);
  const summary = statBox(`${cat.name} · sales`, dollars(cat.netSales), h('div', { class: 'small muted', text: `${Math.round(sold).toLocaleString()} sold · ${cat.items.length} items · no costs yet` }));
  const cards = sideBox('Costs', h('div', { class: 'small muted', text: 'Every drink gets a recipe: a pour from the bottle or keg, a cocktail spec, one can. Then pour cost shows here like food cost does in the kitchen.' }),
    sideActions(h('button', { class: 'btn small-btn', text: 'See what’s missing', onclick: () => coverageScreen(me) })));
  const split = drillDonut({ title: 'sales', crumb: cat.name, format: dollars, items: cat.items.map((i) => ({ name: i.name, value: i.netSales, open: () => breakdownLayer(m, `name=${encodeURIComponent(i.name)}`) })) });
  const bySales = split ? sideBox('Sales by drink', split, h('div', { class: 'small muted', text: `Share of ${cat.name.toLowerCase()} sales in the period. Click a drink for full price against its discount days.` })) : null;
  show(shell(me, 'margins', [header, perfToolbar(me, { ...state, category: cat.name }, m, cat.name, again), page(table, [summary, bySales, cards])]));
}

const UNIT_CHOICES = ['lb', 'oz', 'g', 'kg', 'gal', 'qt', 'pt', 'cup', 'floz', 'l', 'ml', 'each'];
const unitName = (u) => ({ each: 'each', floz: 'fl oz' }[u] ?? u);

/** One dish's plate: each raw ingredient's amount and cost; gaps flagged. */
function plateDetail(d) {
  return h('div', { class: 'plate-detail' },
    h('div', { class: 'small muted', text: `One plate of ${d.name}, as the recipe says, broken down to what you buy. Add-ons and removals are on top: ${dollars(d.plateCost, { cents: true })} on average.` }),
    h('div', { class: 'list' }, d.lines.map((l) => h('div', {},
      h('span', { class: 'grow', text: l.name }),
      h('span', { class: 'small muted nowrap', text: `${l.amount < 0.01 ? l.amount.toPrecision(2) : +l.amount.toFixed(3)} ${unitName(l.unit)}` }),
      l.cost === undefined ? h('span', { class: 'tag warn', text: 'no cost yet' }) : h('b', { class: 'nowrap', text: `$${l.cost.toFixed(2)}` })))));
}

/** The questions that would complete plate costs, one per product. */
function gapsCard(me, gaps, onSaved) {
  if (!gaps?.length) return null;
  const rows = gaps.map((g) => {
    const row = h('div', { class: 'ask' });
    const err = h('div', { class: 'error' });
    const amount = h('input', { inputmode: 'decimal', class: 'amount', 'aria-label': 'Amount', placeholder: 'amount' });
    const unitSelect = (choices, selected) => h('select', { 'aria-label': 'Unit' }, choices.map((u) => h('option', { value: u, text: unitName(u), selected: u === selected ? true : undefined })));
    const save = async (body) => {
      const res = await api('POST', '/api/answers', body);
      if (!res.ok) return (err.textContent = res.data.error ?? 'That didn’t save.');
      onSaved();
    };
    const affects = h('div', { class: 'small muted', text: `Affects ${g.dishes.join(', ')} · ${g.plates.toLocaleString()} plates in this period` });
    let question, form;
    if (g.kind === 'price') {
      const price = h('input', { inputmode: 'decimal', class: 'amount', 'aria-label': 'Price', placeholder: '$' });
      const unit = unitSelect(UNIT_CHOICES, 'lb');
      question = `No recent invoice price for ${g.product}. What does it cost?`;
      form = h('div', { class: 'row wrap' }, h('span', { text: '$' }), price, h('span', { class: 'muted', text: 'for' }), amount, unit,
        h('button', { class: 'btn small-btn dark', text: 'Save', onclick: () => save({ type: 'price', productId: g.productId, price: Number(price.value), amount: Number(amount.value), unit: unit.value }) }));
    } else if (g.needed === 'gramsPerEach') {
      const unit = unitSelect(['lb', 'oz', 'g', 'kg'], 'lb');
      question = `${g.product} is bought by the piece, but the recipes measure it in ${unitName(g.from)}. How much does one weigh, as it comes from the vendor?`;
      form = h('div', { class: 'row wrap' }, h('span', { class: 'muted', text: 'One weighs' }), amount, unit,
        h('button', { class: 'btn small-btn dark', text: 'Save', onclick: () => save({ type: 'conversion', productId: g.productId, fact: 'gramsPerEach', amount: Number(amount.value), amountUnit: unit.value }) }));
    } else if (g.needed === 'gramsPerMl') {
      const volume = ['gal', 'qt', 'pt', 'cup', 'floz', 'l', 'ml', 'tbsp', 'tsp'].includes(g.from) ? g.from : g.to;
      const unit = unitSelect(['oz', 'lb', 'g', 'kg'], 'oz');
      question = `How much does 1 ${unitName(volume)} of ${g.product} weigh?`;
      form = h('div', { class: 'row wrap' }, h('span', { class: 'muted', text: `1 ${unitName(volume)} weighs` }), amount, unit,
        h('button', { class: 'btn small-btn dark', text: 'Save', onclick: () => save({ type: 'conversion', productId: g.productId, fact: 'gramsPerMl', unit: volume, amount: Number(amount.value), amountUnit: unit.value }) }));
    } else {
      const named = g.to;
      const unit = unitSelect(UNIT_CHOICES, 'lb');
      question = `${g.product} comes by the ${named}. What’s in one ${named}?`;
      form = h('div', { class: 'row wrap' }, h('span', { class: 'muted', text: `One ${named} holds` }), amount, unit,
        h('button', { class: 'btn small-btn dark', text: 'Save', onclick: () => save({ type: 'conversion', productId: g.productId, fact: 'customUnit', unit: named, amount: Number(amount.value), amountUnit: unit.value }) }));
    }
    row.append(h('div', { text: question }), affects, form, err);
    return row;
  });
  return h('section', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { class: 'grow', text: `Plate costs with gaps (${gaps.length})` }), h('span', { class: 'small muted', text: 'One answer fixes every dish that uses it.' })),
    h('div', { class: 'small muted', text: 'Dishes marked * leave these out of their cost, so they look cheaper than they are.' }),
    h('div', { class: 'asks' }, rows));
}

// ------------------------------------------------------------------ charts
// Hand-drawn SVG (no chart library): thin lines, gaps where a dish was off the menu,
// a crosshair with one tooltip listing every series, legends that toggle dishes.

const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300']; // validated categorical order
const OTHER = '#b9b4aa';
const SVGNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  for (const c of children.flat()) if (c) el.append(c);
  return el;
}
/** A top for the y axis whose quarter steps are round numbers (4 gridlines). */
function niceMax(v) {
  if (!(v > 0)) return 4;
  const q = v / 4;
  const p = 10 ** Math.floor(Math.log10(q));
  return [1, 2, 2.5, 5, 10].map((x) => x * p).find((x) => x >= q) * 4;
}
const weekLabel = (d) => shortDate(d);

function tooltipBox(wrap) {
  const tip = h('div', { class: 'tip', role: 'status' });
  tip.hidden = true;
  wrap.append(tip);
  return {
    show(x, y, title, rows) {
      fill(tip, h('div', { class: 'tip-title', text: title }), ...rows.map(([color, value, label]) => h('div', { class: 'tip-row' },
        color ? (() => { const k = h('span', { class: 'tip-key' }); k.style.background = color; return k; })() : null,
        h('b', { text: value }), h('span', { class: 'muted', text: label }))));
      tip.hidden = false;
      const w = wrap.clientWidth;
      tip.style.left = `${Math.min(Math.max(x + 14, 0), w - tip.offsetWidth - 4)}px`;
      tip.style.top = `${Math.max(y - 10, 0)}px`;
    },
    hide() { tip.hidden = true; },
  };
}

/** Lines over weeks. series: [{ name, color, values: (number|null)[] }]. */
function lineChart({ weeks, series, format, average }) {
  const direct = series.length >= 2 && series.length <= 4;
  const W = 760, H = 260, L = 52, R = direct ? 130 : 16, T = 14, B = 30;
  const all = series.flatMap((x) => x.values).filter((v) => v !== null);
  const top = niceMax(Math.max(...all, average ?? 0, 0) * 1.05);
  const x = (i) => L + (weeks.length > 1 ? (i / (weeks.length - 1)) * (W - L - R) : (W - L - R) / 2);
  const y = (v) => T + (1 - v / top) * (H - T - B);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': series.map((x) => x.name).join(', ') });
  for (let k = 0; k <= 4; k++) {
    const v = (top / 4) * k;
    svg.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: k ? 'grid' : 'axis' }), s('text', { x: L - 8, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }, document.createTextNode(format(v))));
  }
  const step = Math.max(1, Math.ceil(weeks.length / 7));
  weeks.forEach((w, i) => { if (i % step === 0 || i === weeks.length - 1) svg.append(s('text', { x: x(i), y: H - 8, class: 'tick', 'text-anchor': 'middle' }, document.createTextNode(weekLabel(w)))); });
  if (average !== undefined) svg.append(s('line', { x1: L, x2: W - R, y1: y(average), y2: y(average), class: 'avg' }));
  const labels = [];
  for (const sr of series) {
    let run = [];
    const flush = () => {
      if (run.length > 1) svg.append(s('polyline', { points: run.join(' '), fill: 'none', stroke: sr.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      if (run.length === 1) { const [cx, cy] = run[0].split(','); svg.append(s('circle', { cx, cy, r: 3, fill: sr.color })); }
      run = [];
    };
    sr.values.forEach((v, i) => (v === null ? flush() : run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`)));
    flush();
    const last = sr.values.length - 1 - [...sr.values].reverse().findIndex((v) => v !== null);
    if (last >= 0 && last < sr.values.length && sr.values[last] !== null) labels.push({ name: sr.name, color: sr.color, y: y(sr.values[last]), x: x(last) });
  }
  // Direct labels at the right edge for up to four lines, nudged apart so they don't collide.
  if (direct) {
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
    for (const lb of labels) svg.append(s('circle', { cx: lb.x, cy: lb.y, r: 0 }), s('text', { x: W - R + 8, y: lb.y + 4, class: 'direct' }, document.createTextNode(lb.name.length > 18 ? lb.name.slice(0, 17) + '…' : lb.name)));
  }
  const hair = s('line', { y1: T, y2: H - B, class: 'hair', visibility: 'hidden' });
  const dots = s('g', { visibility: 'hidden' });
  svg.append(hair, dots);
  const wrap = h('div', { class: 'chart' }, svg);
  const tip = tooltipBox(wrap);
  const hit = s('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent', tabindex: 0 });
  const at = (i) => {
    hair.setAttribute('x1', x(i)); hair.setAttribute('x2', x(i)); hair.setAttribute('visibility', 'visible');
    fill(dots, ...series.filter((sr) => sr.values[i] !== null).map((sr) => s('circle', { cx: x(i), cy: y(sr.values[i]), r: 4, fill: sr.color, stroke: '#fff', 'stroke-width': 2 })));
    dots.setAttribute('visibility', 'visible');
    const box = svg.getBoundingClientRect(), wb = wrap.getBoundingClientRect();
    const rows = series.map((sr) => [sr.color, sr.values[i] === null ? 'off the menu' : format(sr.values[i]), sr.name]).sort((a, b) => (parseFloat(String(b[1]).replace(/[^0-9.-]/g, '')) || -1) - (parseFloat(String(a[1]).replace(/[^0-9.-]/g, '')) || -1));
    tip.show((x(i) / W) * box.width + box.left - wb.left, 8, `Week of ${weekLabel(weeks[i])}`, rows);
  };
  const nearest = (clientX) => {
    const box = svg.getBoundingClientRect();
    const px = ((clientX - box.left) / box.width) * W;
    let best = 0;
    weeks.forEach((_, i) => { if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i; });
    return best;
  };
  let focusIdx = weeks.length - 1;
  hit.addEventListener('pointermove', (e) => at((focusIdx = nearest(e.clientX))));
  hit.addEventListener('pointerleave', () => { hair.setAttribute('visibility', 'hidden'); dots.setAttribute('visibility', 'hidden'); tip.hide(); });
  hit.addEventListener('focus', () => at(focusIdx));
  hit.addEventListener('blur', () => { hair.setAttribute('visibility', 'hidden'); dots.setAttribute('visibility', 'hidden'); tip.hide(); });
  hit.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') at((focusIdx = Math.max(0, focusIdx - 1))); if (e.key === 'ArrowRight') at((focusIdx = Math.min(weeks.length - 1, focusIdx + 1))); });
  svg.append(hit);
  return wrap;
}

/** Stacked bars over weeks. series: [{ name, color, values: number[] }], bottom first. */
function stackedBars({ weeks, series, format }) {
  const W = 760, H = 260, L = 52, R = 16, T = 14, B = 30;
  const totals = weeks.map((_, i) => series.reduce((a, sr) => a + Math.max(0, sr.values[i] ?? 0), 0));
  const top = niceMax(Math.max(...totals, 0) * 1.05);
  const band = (W - L - R) / weeks.length;
  const bw = Math.min(42, band * 0.7);
  const y = (v) => T + (1 - v / top) * (H - T - B);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': 'Estimated gross profit, by week' });
  for (let k = 0; k <= 4; k++) {
    const v = (top / 4) * k;
    svg.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: k ? 'grid' : 'axis' }), s('text', { x: L - 8, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }, document.createTextNode(format(v))));
  }
  const step = Math.max(1, Math.ceil(weeks.length / 7));
  const wrap = h('div', { class: 'chart' }, svg);
  const tip = tooltipBox(wrap);
  weeks.forEach((w, i) => {
    const cx = L + band * i + band / 2;
    if (i % step === 0 || i === weeks.length - 1) svg.append(s('text', { x: cx, y: H - 8, class: 'tick', 'text-anchor': 'middle' }, document.createTextNode(weekLabel(w))));
    let base = 0;
    const segs = series.map((sr) => ({ sr, v: Math.max(0, sr.values[i] ?? 0) })).filter((g) => g.v > 0);
    segs.forEach((g, j) => {
      const y0 = y(base), y1 = y(base + g.v);
      const isTop = j === segs.length - 1;
      // 2px surface gap between segments; the top segment gets the rounded end.
      const hgt = Math.max(0, y0 - y1 - (j ? 2 : 0));
      const rect = s(isTop ? 'path' : 'rect', isTop
        ? { d: roundedTop(cx - bw / 2, y1, bw, hgt, Math.min(4, hgt)), fill: g.sr.color, class: 'seg', tabindex: 0 }
        : { x: cx - bw / 2, y: y1, width: bw, height: hgt, fill: g.sr.color, class: 'seg', tabindex: 0 });
      const showTip = () => {
        const box = svg.getBoundingClientRect(), wb = wrap.getBoundingClientRect();
        tip.show((cx / W) * box.width + box.left - wb.left, ((y1 / H) * box.height), `Week of ${weekLabel(w)} · ${format(totals[i])} in all`, [[g.sr.color, format(g.v), g.sr.name]]);
      };
      rect.addEventListener('pointerenter', showTip); rect.addEventListener('focus', showTip);
      rect.addEventListener('pointerleave', () => tip.hide()); rect.addEventListener('blur', () => tip.hide());
      svg.append(rect);
      base += g.v;
    });
  });
  return wrap;
}
function roundedTop(x, y, w, hgt, r) {
  return `M${x},${y + hgt} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + hgt} Z`;
}

function legend(items, onToggle) {
  return h('div', { class: 'legend' }, items.map((it) => {
    const key = h('span', { class: `lkey${it.line ? ' line' : ''}` });
    key.style.background = it.on ? it.color : 'transparent';
    key.style.borderColor = it.color ?? OTHER;
    return h('button', { class: `lchip${it.on ? ' on' : ''}`, 'aria-pressed': it.on ? 'true' : 'false', disabled: !onToggle || it.fixed, onclick: () => onToggle?.(it.name) }, key, it.name);
  }));
}

function chartsView(state, cat, m, again) {
  // Which dishes are charted: the top four by money unless chosen; colors stick to a dish once given.
  const live = cat.dishes;
  const chosen = (state.charted?.[cat.name] ?? live.slice(0, 4).map((d) => d.name)).filter((n) => live.some((d) => d.name === n));
  const colors = { ...(state.chartColors ?? {}) };
  for (const n of chosen) if (!colors[n]) colors[n] = SERIES.find((c) => !chosen.some((o) => colors[o] === c)) ?? OTHER;
  const toggle = (name) => {
    const next = chosen.includes(name) ? chosen.filter((n) => n !== name) : chosen.length >= 6 ? chosen : [...chosen, name];
    const nextColors = { ...colors };
    if (!next.includes(name)) delete nextColors[name];
    again({ charted: { ...(state.charted ?? {}), [cat.name]: next }, chartColors: nextColors });
  };
  const picked = chosen.map((n) => live.find((d) => d.name === n));
  const money = (v) => dollars(Math.round(v));

  const plates = h('section', { class: 'card' },
    h('h2', { text: 'Plates a day, week by week' }),
    h('div', { class: 'small muted', text: 'Plates sold per open day. Gaps are weeks a dish wasn’t on the menu. Hover or use the arrow keys for the numbers.' }),
    legend(live.map((d) => ({ name: d.name, color: colors[d.name], on: chosen.includes(d.name), line: true })), toggle),
    chosen.length >= 6 ? h('div', { class: 'small muted', text: 'Up to 6 dishes at a time: turn one off to add another.' }) : null,
    picked.length ? lineChart({ weeks: m.weeks, series: picked.map((d) => ({ name: d.name, color: colors[d.name], values: d.trend?.series ?? m.weeks.map(() => null) })), format: (v) => (v === 0 ? '0' : v >= 10 || Number.isInteger(v) ? Math.round(v).toString() : v.toFixed(1)) }) : h('p', { class: 'muted', text: 'Pick a dish above.' }));

  const others = live.filter((d) => !chosen.includes(d.name));
  const stack = [...picked.map((d) => ({ name: d.name, color: colors[d.name], values: d.weeklyLeft })), ...(others.length ? [{ name: `Other ${cat.name.toLowerCase()} (${others.length})`, color: OTHER, values: m.weeks.map((_, i) => others.reduce((a, d) => a + (d.weeklyLeft?.[i] ?? 0), 0)) }] : [])];
  const leftBars = h('section', { class: 'card' },
    h('h2', { text: 'Estimated gross profit, week by week' }),
    h('div', { class: 'small muted', text: `Every ${cat.name.toLowerCase()} with a recipe, stacked; the dishes picked above get their own color. Hover a block for its number.` }),
    legend(stack.map((x) => ({ name: x.name, color: x.color, on: true, fixed: true }))),
    stackedBars({ weeks: m.weeks, series: stack, format: money }));

  const fc = cat.weeklyFoodCost ?? [];
  const fcValues = fc.map((v) => (v === null ? null : v * 100));
  const avg = (cat.foodCostShare ?? 0) * 100;
  const foodCost = h('section', { class: 'card' },
    h('h2', { text: `${cat.name} food cost, week by week · ${pct(cat.foodCostShare)} for the period` }),
    h('div', { class: 'small muted', text: 'Food cost as a share of sales, on dishes with recipes. The dashed line is the period’s average.' }),
    lineChart({ weeks: m.weeks, series: [{ name: 'Food cost', color: SERIES[0], values: fcValues }], format: (v) => (v === 0 ? '0%' : `${Number.isInteger(v) ? v : v.toFixed(1)}%`), average: avg }));

  return [plates, leftBars, foodCost];
}

// ------------------------------------------------------------------ prep lists

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayName = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
const qty = (n) => (n === undefined || n === null ? '–' : Number.isInteger(n) ? String(n) : String(+n.toFixed(2)));
const plural = (n, unit) => (!unit ? '' : n === 1 || unit.includes('/') ? unit : unit.endsWith('h') ? `${unit}es` : `${unit}s`);
const amountText = (n, unit) => `${qty(n)}${unit ? ' ' + plural(n, unit) : ''}`;
const timeOf = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const remember = (k, v) => { try { v === undefined ? localStorage.getItem(k) : localStorage.setItem(k, v); } catch {} };
const recall = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

let prepRefresh;
async function prepHome(me, allStations = false, quiet = false) {
  clearTimeout(prepRefresh);
  if (!quiet) loadingScreen(me, 'prep', 'Prep');
  const r = await api('GET', '/api/prep');
  if (!r.ok) return show(shell(me, 'prep', [h('h1', { text: 'Prep' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const p = r.data;
  const newStation = () => {
    const err = h('span', { class: 'error' });
    const name = h('input', { type: 'text', placeholder: 'e.g. Bar', 'aria-label': 'Station name' });
    const form = h('form', { class: 'card row wrap', onsubmit: async (e) => {
        e.preventDefault();
        const res = await api('POST', '/api/prep/stations', { name: name.value });
        if (!res.ok) return (err.textContent = res.data.error ?? 'Not saved.');
        prepEdit(me, res.data.id);
      } }, h('div', { class: 'grow' }, name), h('button', { class: 'btn dark', type: 'submit', text: 'Add station' }), err);
    return form;
  };
  const addStation = p.canEdit ? h('button', { class: 'btn', text: 'New station', onclick: (e) => { e.target.replaceWith(newStation()); } }) : null;
  const how = sideBox('How prep works', h('ol', { class: 'steps' },
    h('li', { text: 'At night, each station counts what’s left.' }),
    h('li', { text: 'A chef reviews the suggestions and approves.' }),
    h('li', { text: 'Next day, the station preps from the approved list, cleaning last.' })));
  const book = sideBox('Recipes', h('div', { class: 'small muted', text: 'Every prep on a list opens its recipe, scaled to what the list says to make.' }),
    sideActions(h('button', { class: 'btn small-btn', text: 'Recipe book', onclick: () => recipesScreen(me) })));
  if (!p.stations.length) {
    return show(shell(me, 'prep', [h('header', {}, h('h1', { text: 'Prep' }), h('div', { class: 'sub', text: 'No station lists yet.' })),
      page([h('div', { class: 'card small muted', text: 'A manager can import the station lists under Settings → Prep lists, or add a station here.' }), addStation], [how])]));
  }
  const status = (l, kind) => {
    if (!l) return h('span', { class: 'tag', text: kind === 'tomorrow' ? 'Not counted' : 'No list' });
    if (l.status === 'approved') return h('span', { class: 'tag ok', text: kind === 'today' && Number(l.done) ? `Approved · ${l.done} done` : 'Approved' });
    return Number(l.counted) ? h('span', { class: 'tag warn', text: `Counted · waiting for chef` }) : h('span', { class: 'tag', text: 'Not counted' });
  };
  // An iPad that belongs to a station shows just that one; the rest are a tap away.
  const mine = me.device?.stationId && p.stations.find((s) => s.id === me.device.stationId);
  const shown = mine && !allStations ? [mine] : p.stations;
  // One station per row, full width: today and tonight on the left, how long its prep takes on the right.
  const cards = shown.map((s) => h('section', { class: 'card station-card' },
    h('div', { class: 'row' }, h('h2', { class: 'grow', text: s.name }), p.canEdit ? h('button', { class: 'link', text: 'Edit list', onclick: () => prepEdit(me, s.id) }) : null),
    liveStrip(s),
    h('div', { class: 'station-body' },
      h('div', { class: 'station-days' },
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'small muted', text: `Today · ${dayName(p.today)}` }), h('div', { class: 'row tight wrap' }, status(s.today, 'today'), goingText(s))),
          h('button', { class: 'btn dark', text: 'Today’s prep', onclick: () => { remember('station', s.id); prepWork(me, s.id, p.today); } })),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'small muted', text: `Tonight’s count for ${dayName(p.tomorrow)}` }), status(s.tomorrow, 'tomorrow')),
          h('button', { class: 'btn', text: 'Count', onclick: () => prepCount(me, s.id, p.tomorrow) }),
          p.canApprove ? h('button', { class: 'btn', text: 'Review', onclick: () => prepReview(me, s.id, p.tomorrow) }) : null)),
      stationTime(s))));
  // Tonight's counts at a glance: how many stations are counted and approved.
  const counted = p.stations.filter((s) => s.tomorrow && (s.tomorrow.status === 'approved' || Number(s.tomorrow.counted))).length;
  const approved = p.stations.filter((s) => s.tomorrow?.status === 'approved').length;
  const tonight = sideBox(`Tonight · for ${dayName(p.tomorrow)}`, progress(approved, p.stations.length),
    h('div', { class: 'small', text: `${counted} of ${p.stations.length} counted · ${approved} approved` }));
  const plans = atLeast(me.roleLevel, 'chef') ? (await api('GET', '/api/plans')).data?.plans?.filter((x) => x.status === 'planned') ?? [] : [];
  const coming = plans.length ? sideBox('Coming to the menu', h('div', { class: 'list compact' }, plans.map((x) => h('div', {}, h('span', { class: 'grow', text: x.name }), h('span', { class: 'small muted', text: `from ${shortDate(x.startsOn)}` })))),
    h('button', { class: 'link', text: 'Plan it on Menu', onclick: () => menuScreen(me) })) : null;
  show(shell(me, 'prep', [
    h('header', {}, h('div', { class: 'kicker', text: dayName(p.today) }), h('h1', { text: 'Prep' }),
      h('div', { class: 'sub', text: 'Each station’s list for today, and tonight’s count.' })),
    page([
      mine ? h('div', { class: 'row' }, h('div', { class: 'grow small muted', text: allStations ? `This iPad is the ${mine.name} station’s.` : `This iPad is the ${mine.name} station’s. Other stations are a tap away.` }),
        h('button', { class: 'link', text: allStations ? `Just ${mine.name}` : 'All stations', onclick: () => prepHome(me, !allStations) })) : null,
      h('div', { class: 'stack' }, cards), addStation ? h('div', {}, addStation) : null,
    ], [liveNow(p), tonight, p.insights ? prepInsights(p) : null, coming, how, book])]));
  // While prep is under way, the page keeps itself current (only while it's still the one showing).
  if (p.stations.some((x) => x.live && !x.live.finished)) {
    prepRefresh = setTimeout(() => { if (document.querySelector('.station-card')) prepHome(me, allStations, true); }, 30000);
  }
}

/** How a list in progress is doing against its usual time: on track within 10 minutes either way. */
function paceWords(l) {
  if (l.behind === undefined) return { cls: '', text: `Heading for ${l.finishAt}` };
  if (l.behind > 10) return { cls: 'warn-text', text: `Heading for ${l.finishAt} · ~${duration(l.behind)} behind` };
  if (l.behind < -10) return { cls: 'trend-up', text: `Heading for ${l.finishAt} · ~${duration(-l.behind)} ahead` };
  return { cls: '', text: `On track for ${l.finishAt}` };
}

/** Live, across the top of a station's box while its list is under way (or just finished). */
function liveStrip(s) {
  const l = s.live;
  if (!l) return null;
  if (l.finished) return h('div', { class: 'live-strip done' }, h('span', { class: 'tag ok', text: 'Done' }),
    h('span', { class: 'small', text: `${l.doneAt ? `Finished ${l.doneAt} · ` : ''}took ${duration(l.took)}${l.usualMinutes ? ` (usually ${duration(l.usualMinutes)})` : ''}` }));
  const pace = paceWords(l);
  return h('div', { class: 'live-strip' },
    h('div', { class: 'row tight wrap' }, h('span', { class: 'tag live', text: 'Live' }),
      h('span', { class: 'strong', text: `${l.done} of ${l.total} done · ${duration(l.minutesIn)} in` }),
      h('span', { class: 'grow' }), h('span', { class: `small strong ${pace.cls}`, text: pace.text })),
    progress(l.done, l.total),
    h('div', { class: 'small muted' }, l.now.length ? [h('span', { class: 'ink', text: 'Now: ' }), l.now.map((x) => `${x.name}${x.by ? ` (${x.by}, ${duration(x.minutes)})` : ''}`).join(' · ')] : null,
      l.now.length && l.next.length ? ' · ' : null, l.next.length ? `Next: ${l.next.join(', ')}` : null,
      l.cleaningLeft ? `${l.now.length || l.next.length ? ' · ' : ''}${l.cleaningLeft} cleaning task${l.cleaningLeft === 1 ? '' : 's'} left` : null));
}

/** Every station under way, at the top of the right column. */
function liveNow(p) {
  const going = p.stations.filter((s) => s.live && !s.live.finished);
  if (!going.length) return null;
  return sideBox('Live now', h('div', { class: 'list compact' }, going.map((s) => {
    const pace = paceWords(s.live);
    return h('div', { class: 'live-row' }, h('span', { class: 'grow' }, h('span', { class: 'strong', text: s.name }), h('span', { class: 'small muted block', text: `${s.live.done} of ${s.live.total} · ${duration(s.live.minutesIn)} in` })),
      h('span', { class: `small right ${pace.cls}`, text: s.live.behind !== undefined && Math.abs(s.live.behind) > 10 ? `${s.live.finishAt}\n${s.live.behind > 0 ? '+' : '−'}${shortDuration(Math.abs(s.live.behind))}` : s.live.finishAt }));
  })), h('div', { class: 'small muted', text: 'Expected finish, from the usual time for what’s left. Updates every 30 seconds.' }));
}

/** "1 h 35 min", "45 min". */
const duration = (min) => (min < 60 ? `${Math.round(min)} min` : `${Math.floor(min / 60)} h${Math.round(min % 60) ? ` ${Math.round(min % 60)} min` : ''}`);
const shortDuration = (min) => (min < 60 ? `${Math.round(min)}m` : `${Math.floor(min / 60)}h${String(Math.round(min % 60)).padStart(2, '0')}`);

/** Today's list under way: when it started and how long it's been going. */
function goingText(s) {
  if (!s.going || s.live) return null; // the live strip says it already
  const mins = Math.max(0, (Date.now() - Date.parse(s.going.startedAt)) / 60000);
  return h('span', { class: 'small muted', text: `Started ${s.going.start}${s.going.by ? ` by ${s.going.by}` : ''} · ${duration(mins)} ago` });
}

/** A station's usual prep time, and its recent lists as small bars (the latest darkest). */
function stationTime(s) {
  const t = s.timing;
  if (!t?.lists?.length) return h('div', { class: 'station-time empty' }, h('div', { class: 'small muted', text: 'Usual time to finish shows here once a few lists are checked off.' }));
  const W = 220, H = 40, gap = 3, n = t.lists.length, bw = Math.max(4, (W - gap * (n - 1)) / Math.max(n, 7));
  const max = Math.max(...t.lists.map((l) => l.minutes), t.usualMinutes, 1);
  const svg = s_('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'time-bars', role: 'img', 'aria-label': `Last ${n} lists: ${t.lists.map((l) => `${shortDate(l.date)} ${duration(l.minutes)}`).join(', ')}` });
  t.lists.forEach((l, i) => {
    const bh = Math.max(2, (l.minutes / max) * (H - 4));
    const r = s_('rect', { x: i * (bw + gap), y: H - bh, width: bw, height: bh, class: i === n - 1 ? 'last' : '' });
    r.append(s_('title', {}, document.createTextNode(`${weekdayName(l.date)} ${shortDate(l.date)}: ${duration(l.minutes)}, ${l.start} – ${l.end}`)));
    svg.append(r);
  });
  const uy = H - (t.usualMinutes / max) * (H - 4);
  svg.append(s_('line', { x1: 0, x2: W, y1: uy, y2: uy, class: 'usual' }));
  return h('div', { class: 'station-time' },
    h('div', { class: 'small muted strong', text: 'Usual time to finish' }),
    h('div', { class: 'big-ish', text: duration(t.usualMinutes) }), h('div', { class: 'small muted', text: `Usually ${t.usualStart} – ${t.usualEnd}` }),
    svg, h('div', { class: 'small muted', text: `Last ${n} lists · the line is the usual` }));
}

/** The right column, for managers: how long prep takes, which items take longest, each cook's pace. */
function prepInsights(p) {
  const x = p.insights;
  if (!x.timed) return sideBox('Prep times', h('div', { class: 'small muted', text: 'How long each list and item takes shows here once cooks have checked off a few lists. A tap on Start prep at the top of the list makes the times exact.' }));
  const timed = p.stations.filter((s) => s.timing?.usualMinutes);
  const most = Math.max(...timed.map((s) => s.timing.usualMinutes), 1);
  const byStation = timed.length ? sideBox(`Time to finish, last ${Math.round(x.days / 7)} weeks`,
    h('div', { class: 'hbars' }, timed.map((s) => h('div', { class: 'hbar' },
      h('span', { class: 'hbar-label', text: s.name }),
      (() => { const b = h('span', { class: 'hbar-track' }, h('span', { class: 'hbar-fill' })); b.firstChild.style.width = `${(s.timing.usualMinutes / most) * 100}%`; return b; })(),
      h('b', { class: 'hbar-value', text: shortDuration(s.timing.usualMinutes) })))),
    h('div', { class: 'small muted', text: 'The usual list, start to last check-off.' })) : null;
  const slowest = Math.max(...x.slowItems.map((i) => i.minutes), 1);
  const items = x.slowItems.length ? sideBox('Takes longest',
    h('div', { class: 'hbars' }, x.slowItems.map((i) => h('div', { class: 'hbar two-line' },
      h('span', { class: 'hbar-label' }, h('span', { class: 'strong', text: i.name }), h('span', { class: 'small muted block', text: `${i.station ?? ''}${i.amount ? ` · ${qty(i.amount)} ${plural(i.amount, i.unit)}` : ''}` })),
      (() => { const b = h('span', { class: 'hbar-track' }, h('span', { class: 'hbar-fill' })); b.firstChild.style.width = `${(i.minutes / slowest) * 100}%`; return b; })(),
      h('b', { class: 'hbar-value', text: `${i.minutes}m` })))),
    h('div', { class: 'small muted', text: 'The usual time for each, for the amount usually made.' })) : null;
  // Pace: centred on the usual; quicker to the left, slower to the right. Same items, same amounts.
  const span = Math.max(0.25, ...x.cooks.map((c) => Math.abs(c.ratio - 1)));
  const pace = x.cooks.length ? sideBox('Pace by cook',
    h('div', { class: 'pace' }, x.cooks.map((c) => {
      const off = c.ratio - 1, steady = Math.abs(off) < 0.05;
      const bar = h('span', { class: 'pace-track' }, h('span', { class: `pace-fill ${steady ? 'even' : off < 0 ? 'quick' : 'slow'}` }), h('span', { class: 'pace-mid' }));
      const w = (Math.min(Math.abs(off), span) / span) * 50;
      Object.assign(bar.firstChild.style, off < 0 ? { right: '50%', width: `${w}%` } : { left: '50%', width: `${Math.max(w, steady ? 1 : 0)}%` });
      return h('div', { class: 'pace-row' }, h('span', { class: 'pace-name', text: c.name }), bar,
        h('span', { class: `pace-value ${steady ? '' : off < 0 ? 'trend-up' : 'warn-text'}`, text: steady ? 'usual' : `${Math.round(Math.abs(off) * 100)}% ${off < 0 ? 'quicker' : 'slower'}` }),
        h('span', { class: 'small muted pace-n', text: `${c.items} items` }));
    })),
    h('div', { class: 'small muted', text: 'Each cook against the usual time for the same items in the same amounts, so who makes the dough isn’t held against them. Shown after 8 timed items; only managers see this.' }),
    h('div', { class: 'small muted', text: `From ${x.timed} item times in the last ${Math.round(x.days / 7)} weeks: ${Math.round((x.exact / x.timed) * 100)}% timed from a Start tap, the rest from the time between check-offs (breaks left out).` })) : null;
  return [byStation, items, pace];
}
const s_ = (tag, attrs = {}, ...kids) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) if (v !== '' && v !== undefined) el.setAttribute(k, v); for (const c of kids) el.append(c); return el; };

function prepHeader(me, v, title, sub, extra) {
  return h('header', { class: 'row' },
    h('div', { class: 'grow' }, h('div', { class: 'kicker', text: `${v.station.name} · ${dayName(v.date)}` }), h('h1', { text: title }), sub ? h('div', { class: 'sub', text: sub }) : null),
    extra ?? null, h('button', { class: 'btn', text: '← Stations', onclick: () => prepHome(me) }));
}

function stepper(value, step, onChange, label) {
  const input = h('input', { inputmode: 'decimal', class: 'amount', value: value === undefined || value === null ? '' : qty(value), 'aria-label': label, placeholder: '–' });
  const set = (v) => { input.value = v === null ? '' : qty(v); onChange(v); };
  input.addEventListener('change', () => set(input.value.trim() === '' ? null : Math.max(0, Number(input.value) || 0)));
  return h('div', { class: 'stepper' },
    h('button', { class: 'btn small-btn', 'aria-label': `Less ${label}`, text: '−', onclick: () => set(Math.max(0, (Number(input.value) || 0) - step)) }),
    input,
    h('button', { class: 'btn small-btn', 'aria-label': `More ${label}`, text: '+', onclick: () => set((Number(input.value) || 0) + step) }));
}

// Tonight: count what's left, in the station's own units.
async function prepCount(me, stationId, date) {
  const r = await api('GET', `/api/prep/${stationId}/${date}`);
  if (!r.ok) return show(shell(me, 'prep', [h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const v = r.data;
  const countable = v.lines.filter((l) => l.kind === 'count' || l.kind === 'batch');
  const counted = countable.filter((l) => l.counted !== undefined).length;
  const toCount = countable.length;
  const rows = countable.map((l) => {
    const isBatch = l.kind === 'batch';
    const need = h('span', { class: 'small muted nowrap', text: l.toMake !== undefined ? `make ${amountText(l.toMake, l.unit)}` : '' });
    return h('div', { class: 'countrow' },
      h('div', { class: 'grow' }, h('div', { class: 'name', text: l.name }), h('div', { class: 'small muted', text: isBatch
        ? (l.bulkUnit ? `Optional: on hand in ${l.bulkUnit}. ${l.onHand ? `The app has ${l.onHand.estimated ? 'about ' : ''}${qty(l.onHand.amount)} ${l.bulkUnit}.` : 'Nothing recorded yet.'}` : 'Set its storage unit under Edit list to track it.')
        : `${l.unit ?? ''}${l.dayPar !== undefined ? ` · par ${qty(l.dayPar)}` : ''}${l.note ? ` · ${l.note}` : ''}` })),
      isBatch ? h('span') : need,
      isBatch && !l.bulkUnit ? h('span') : stepper(l.counted, isBatch ? 0.5 : l.dayPar !== undefined && l.dayPar < 4 ? 0.5 : 1, async (val) => {
        const res = await api('POST', `/api/prep/${stationId}/${date}/count`, { itemId: l.id, counted: val });
        if (res.ok) { const nl = res.data.lines.find((x) => x.id === l.id); need.textContent = nl?.toMake !== undefined ? `make ${amountText(nl.toMake, nl.unit)}` : ''; }
        else need.textContent = res.data.error ?? 'Not saved';
      }, `${l.name} on hand`));
  });
  const left = countable.filter((l) => l.counted === undefined && (l.kind === 'count' || l.bulkUnit));
  show(shell(me, 'prep', [
    prepHeader(me, v, 'Count', v.status === 'approved' ? 'Already approved for tomorrow. A chef can reopen it to change counts.' : 'How much is left of each, in the station’s units.'),
    page(h('section', { class: 'card' }, h('div', { class: 'list' }, rows)), [
      sideBox('Counted', progress(counted, toCount), h('div', { class: 'small', text: `${counted} of ${toCount}` }),
        sideActions(h('button', { class: 'btn dark', text: 'Done counting', onclick: () => prepHome(me) }))),
      left.length && left.length < toCount ? sideBox('Not counted yet', h('div', { class: 'small', text: left.map((l) => l.name).join(' · ') })) : null,
      sideBox('Tips', h('div', { class: 'small muted', text: 'Counts save as you go. Bulk items are optional: count them when you know, and the suggestion for what fills from them gets sharper.' })),
    ]),
  ]));
}

// The chef's review: suggestions with reasons, any number can change, then approve.
async function prepReview(me, stationId, date) {
  const r = await api('GET', `/api/prep/${stationId}/${date}`);
  if (!r.ok) return show(shell(me, 'prep', [h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const v = r.data;
  const again = () => refreshInPlace(() => prepReview(me, stationId, date));
  const make = (l, val) => api('POST', `/api/prep/${stationId}/${date}/make`, { itemId: l.id, toMake: val });
  const uncounted = v.lines.filter((l) => l.kind === 'count' && l.counted === undefined);
  const rows = v.lines.map((l) => {
    if (l.kind === 'task') return h('div', { class: 'reviewrow' }, h('div', { class: 'grow' }, h('div', { class: 'name', text: l.name }), h('div', { class: 'small muted', text: 'Daily task' })));
    const info = l.kind === 'batch'
      ? l.reason ?? (l.onHand && l.bulkUnit ? `${l.onHand.estimated ? 'About ' : ''}${qty(l.onHand.amount)} ${l.bulkUnit} on hand. Link the station items it fills (Edit list) for a suggestion.` : 'Bulk, made as needed: set its unit and batch size and link the station items it fills (Edit list) for a suggestion. Leave empty to skip.')
      : l.counted === undefined ? `Par ${qty(l.dayPar)} · not counted` : l.reason ?? '';
    const changed = l.chosen !== undefined && l.suggested !== undefined && l.chosen !== l.suggested;
    return h('div', { class: 'reviewrow' },
      h('div', { class: 'grow' }, h('div', { class: 'name', text: l.name }), h('div', { class: 'small muted', text: `${l.unit ?? ''}${l.note ? ` · ${l.note}` : ''}` }), h('div', { class: `small${changed ? ' changed' : ' muted'}`, text: changed ? `${info} You changed it from ${qty(l.suggested)}.` : info })),
      h('div', { class: 'small muted nowrap', text: 'Make' }),
      stepper(l.toMake, l.dayPar !== undefined && l.dayPar < 4 ? 0.5 : 1, async (val) => { await make(l, val); }, `${l.name} to make`),
      changed ? h('button', { class: 'link', text: 'Use suggestion', onclick: async () => { await make(l, null); again(); } }) : null);
  });
  const approved = v.status === 'approved';
  const approve = h('button', { class: `btn ${approved ? '' : 'dark'}`, text: approved ? 'Reopen' : 'Approve', onclick: async () => {
      const res = await api('POST', `/api/prep/${stationId}/${date}/approve`, { approved: !approved });
      if (res.ok) again();
    } });
  const share = v.share !== undefined && v.share < 1 ? `${WEEKDAY[new Date(`${date}T12:00:00`).getDay()]} usually runs at ${Math.round(v.share * 100)}% of a ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][v.busiest]}, so pars are scaled to that. ` : '';
  const toMake = v.lines.filter((l) => l.kind !== 'task' && (l.toMake ?? 0) > 0).length;
  show(shell(me, 'prep', [
    prepHeader(me, v, approved ? 'Approved' : 'Review and approve', approved ? 'The station sees this list tomorrow.' : 'Change any number, then approve.'),
    page(h('section', { class: 'card' }, h('div', { class: 'list' }, rows)), [
      sideBox(approved ? 'Approved' : 'Not approved yet',
        h('div', { class: 'small', text: approved ? `By ${v.approvedBy ?? 'a chef'}${v.approvedAt ? ' at ' + timeOf(v.approvedAt) : ''}.` : `Counted by ${v.countedBy ?? 'nobody yet'}. ${toMake} thing${toMake === 1 ? '' : 's'} to make.` }),
        sideActions(approve)),
      uncounted.length && !approved ? (uncounted.length === v.lines.filter((l) => l.kind === 'count').length
        ? sideBox('Not counted', h('div', { class: 'small', text: 'Nothing on this list has been counted yet, so there’s nothing to suggest.' }), sideActions(h('button', { class: 'btn small-btn', text: 'Count now', onclick: () => prepCount(me, stationId, date) })))
        : sideBox(`Not counted (${uncounted.length})`, h('div', { class: 'small', text: uncounted.map((l) => l.name).join(' · ') }), h('div', { class: 'small muted', text: 'With no count, nothing is suggested for them.' }))) : null,
      share ? sideBox('Pars', h('div', { class: 'small muted', text: share.trim() })) : null,
    ]),
  ]));
}

// The day's work: the approved list, then cleaning.
async function prepWork(me, stationId, date) {
  const r = await api('GET', `/api/prep/${stationId}/${date}`);
  if (!r.ok) return show(shell(me, 'prep', [h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const v = r.data;
  const again = () => refreshInPlace(() => prepWork(me, stationId, date));
  if (v.status !== 'approved') {
    return show(shell(me, 'prep', [prepHeader(me, v, 'Today’s prep', 'This list hasn’t been approved yet.'),
      page(h('div', { class: 'card small muted', text: 'A chef approves the list after last night’s count. It shows up here once that’s done.' }),
        v.canApprove ? sideBox('Approve', sideActions(h('button', { class: 'btn dark', text: 'Review it now', onclick: () => prepReview(me, stationId, date) }))) : null)]));
  }
  const work = v.lines.filter((l) => l.kind === 'task' || (l.toMake ?? 0) > 0);
  const done = work.filter((l) => l.doneAt).length;
  // A check-off shows at once; the save and the fresh list follow. If the save fails, it un-checks with the reason.
  const act = async (l, state, btn) => {
    const row = btn?.closest('.workrow');
    if (btn && (state === 'done' || state === 'undo')) {
      pressed = null;
      btn.classList.toggle('on', state === 'done'); btn.textContent = state === 'done' ? '✓' : ''; row?.classList.toggle('done', state === 'done'); btn.disabled = true;
    }
    const res = await api('POST', `/api/prep/${stationId}/${date}/done`, { itemId: l.id, state });
    if (res.ok) return again();
    if (btn) { btn.classList.toggle('on', Boolean(l.doneAt)); btn.textContent = l.doneAt ? '✓' : ''; row?.classList.toggle('done', Boolean(l.doneAt)); btn.disabled = false; }
    row?.append(h('div', { class: 'error small', text: res.data.error ?? 'That didn’t save.' }));
  };
  const rows = work.map((l) => h('div', { class: `workrow${l.doneAt ? ' done' : ''}` },
    h('button', { class: `check${l.doneAt ? ' on' : l.startedAt ? ' started' : ''}`, 'aria-label': l.doneAt ? `Undo ${l.name}` : `Mark ${l.name} done`, onclick: (e) => act(l, l.doneAt ? 'undo' : 'done', e.currentTarget) }, l.doneAt ? '✓' : ''),
    h('div', { class: 'grow' },
      h('div', { class: 'name', text: l.name }),
      h('div', { class: 'small', text: l.kind === 'task' ? 'Daily' : `Make ${amountText(l.toMake, l.unit)}${l.note ? ` · ${l.note}` : ''}` }),
      h('div', { class: 'small muted', text: l.doneAt ? `Done by ${l.doneBy ?? ''} at ${timeOf(l.doneAt)}` : l.startedAt ? `Started by ${l.startedBy ?? ''} at ${timeOf(l.startedAt)}` : '' })),
    l.recipeName ? h('button', { class: 'btn', text: 'Recipe', onclick: () => recipeSheet(me, l.recipeName, { amount: l.toMake, unit: l.unit }) }) : null,
    !l.doneAt && !l.startedAt && l.kind !== 'task' ? h('button', { class: 'btn', text: 'Start', onclick: () => act(l, 'start') }) : null));
  const cleanDone = v.checklist.filter((c) => c.doneAt).length;
  const cleaning = sideBox(`Cleaning · ${cleanDone} of ${v.checklist.length}`,
    h('div', { class: 'list' }, v.checklist.map((c) => h('div', {},
      h('button', { class: `check small${c.doneAt ? ' on' : ''}`, 'aria-label': c.doneAt ? `Undo ${c.name}` : `Mark ${c.name} done`, onclick: async () => { const res = await api('POST', `/api/prep/${stationId}/${date}/check`, { checklistId: c.id, done: !c.doneAt }); if (res.ok) again(); } }, c.doneAt ? '✓' : ''),
      h('span', { class: 'grow', text: c.name }), c.frequency === 'weekly' ? h('span', { class: 'tag', text: 'weekly' }) : null,
      c.doneAt ? h('span', { class: 'small muted nowrap', text: `${c.doneBy ?? ''} ${timeOf(c.doneAt)}` }) : null))));
  show(shell(me, 'prep', [
    prepHeader(me, v, `${v.station.name} prep`, `Approved by ${v.approvedBy ?? 'the chef'}. Cleaning last.`),
    page(h('section', { class: 'card' }, work.length ? h('div', { class: 'list' }, rows) : h('div', { class: 'muted', text: 'Nothing to make today.' })), [
      clockBox(v, done, work.length, async (undo) => { const res = await api('POST', `/api/prep/${stationId}/${date}/start`, undo ? { undo: true } : {}); if (res.ok) again(); }),
      v.checklist.length ? cleaning : null,
    ]),
  ]));
}

/** Move up, move down, remove: small, at the end of a line in the list editor. */
function editTools(up, down, name, remove) {
  return h('div', { class: 'edit-tools' },
    h('button', { class: 'btn small-btn', 'aria-label': `Move ${name} up`, title: 'Move up', text: '↑', onclick: up }),
    h('button', { class: 'btn small-btn', 'aria-label': `Move ${name} down`, title: 'Move down', text: '↓', onclick: down }),
    h('button', { class: 'btn small-btn remove', 'aria-label': `Remove ${name}`, title: 'Remove', text: '×', onclick: remove }));
}

/** The list's clock: Start prep once at the top, then how long it's been going against the usual. */
function clockBox(v, done, total, start) {
  const first = v.workStartedAt ?? [...v.lines.map((l) => l.startedAt), ...v.lines.map((l) => l.doneAt)].filter(Boolean).sort()[0];
  const finished = total > 0 && done >= total;
  const last = v.lines.map((l) => l.doneAt).filter(Boolean).sort().pop();
  const mins = first ? Math.max(0, ((finished && last ? Date.parse(last) : Date.now()) - Date.parse(first)) / 60000) : 0;
  const usual = v.usualMinutes ? h('div', { class: 'small muted', text: `Usually ${duration(v.usualMinutes)}.` }) : null;
  if (!first) return sideBox('Prep', progress(0, total), h('div', { class: 'small', text: `${total} thing${total === 1 ? '' : 's'} to make` }),
    sideActions(h('button', { class: 'btn dark', text: 'Start prep', onclick: () => start() })),
    h('div', { class: 'small muted', text: 'Tap when you begin, so the list’s time is right.' }), usual);
  return sideBox(finished ? 'Done' : 'Going', progress(done, total),
    h('div', { class: 'small', text: `${done} of ${total} · ${finished ? `took ${duration(mins)}` : `${duration(mins)} so far`}` }),
    h('div', { class: 'small muted', text: v.workStartedAt ? `Started ${timeOf(v.workStartedAt)}${v.workStartedBy ? ` by ${v.workStartedBy}` : ''}.` : `First check-off ${timeOf(first)}.` }),
    usual,
    v.workStartedAt && !done ? h('button', { class: 'link', text: 'Not started yet', onclick: () => start(true) }) : null);
}

// Editing a station's list: items (name, unit, par, kind, days) and cleaning tasks.
async function prepEdit(me, stationId) {
  const r = await api('GET', `/api/prep/${stationId}/setup`);
  if (!r.ok) return show(shell(me, 'prep', [h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const s = r.data;
  const again = () => refreshInPlace(() => prepEdit(me, stationId));
  const save = async (path, body) => { const res = await api('POST', path, body); if (!res.ok) alertLine.textContent = res.data.error ?? 'Not saved'; return res.ok; };
  const alertLine = h('div', { class: 'error', role: 'alert' });
  const move = async (list, i, dir, key) => {
    const ids = list.map((x) => x.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await save(`/api/prep/${stationId}/order`, { [key]: ids });
    again();
  };
  const itemRow = (it, i) => {
    const name = h('input', { type: 'text', value: it.name, 'aria-label': 'Item name' });
    const unit = h('input', { type: 'text', value: it.unit ?? '', placeholder: 'unit', class: 'unit-in', 'aria-label': 'Unit' });
    const par = h('input', { inputmode: 'decimal', class: 'amount', value: it.par ?? '', placeholder: 'par', 'aria-label': 'Par' });
    const kind = h('select', { 'aria-label': 'Kind' }, [['count', 'Count'], ['task', 'Daily task'], ['batch', 'Bulk, as needed']].map(([k, t]) => h('option', { value: k, text: t, selected: it.kind === k ? true : undefined })));
    const days = it.weekdays ?? [];
    const dayChips = h('div', { class: 'row tight wrap' }, WEEKDAY.map((d, n) => h('button', { class: `lchip${days.includes(n) ? ' on' : ''}`, 'aria-pressed': days.includes(n) ? 'true' : 'false', text: d, onclick: async () => {
        const next = days.includes(n) ? days.filter((x) => x !== n) : [...days, n].sort();
        if (await save(`/api/prep/items/${it.id}`, { weekdays: next.length ? next : null })) again();
      } })));
    const commit = () => save(`/api/prep/items/${it.id}`, { name: name.value, unit: unit.value, par: par.value.trim() === '' ? null : Number(par.value), kind: kind.value });
    for (const el of [name, unit, par, kind]) el.addEventListener('change', commit);
    const others = (s.batchItems ?? []).filter((b) => b.id !== it.id);
    const source = h('select', { 'aria-label': 'Filled from bulk' }, h('option', { value: '', text: 'Not from a bulk batch' }), others.map((b) => h('option', { value: b.id, text: `${b.name} (${b.station})`, selected: it.sourceItemId === b.id ? true : undefined })));
    const holds = h('input', { inputmode: 'decimal', class: 'amount', value: it.holds ?? '', placeholder: '?', 'aria-label': 'How much one container holds' });
    const sourceItem = others.find((b) => b.id === it.sourceItemId);
    source.addEventListener('change', async () => { if (await save(`/api/prep/items/${it.id}`, { sourceItemId: source.value || null })) again(); });
    holds.addEventListener('change', () => save(`/api/prep/items/${it.id}`, { holds: holds.value.trim() === '' ? null : Number(holds.value) }));
    const bulkUnit = h('input', { type: 'text', class: 'unit-in', value: it.bulkUnit ?? '', placeholder: 'qt, lb, each…', 'aria-label': 'Kept in' });
    const batchYield = h('input', { inputmode: 'decimal', class: 'amount', value: it.batchYield ?? '', placeholder: '?', 'aria-label': 'One batch makes' });
    bulkUnit.addEventListener('change', async () => { if (await save(`/api/prep/items/${it.id}`, { bulkUnit: bulkUnit.value })) again(); });
    batchYield.addEventListener('change', () => save(`/api/prep/items/${it.id}`, { batchYield: batchYield.value.trim() === '' ? null : Number(batchYield.value) }));
    const recipeSelect = h('select', { 'aria-label': 'Recipe' }, h('option', { value: '', text: 'No recipe' }), (s.recipes ?? []).map((r) => h('option', { value: r.name, text: r.name, selected: it.recipeName === r.name ? true : undefined })));
    recipeSelect.addEventListener('change', async () => { if (await save(`/api/prep/items/${it.id}`, { recipeName: recipeSelect.value || null })) again(); });
    const recipeRow = h('div', { class: 'row tight' }, h('span', { class: 'small muted', text: 'Recipe' }), recipeSelect,
      it.recipeSuggestion ? h('button', { class: 'btn small-btn blue', text: `${it.recipeSuggestion}?`, onclick: async () => { if (await save(`/api/prep/items/${it.id}`, { recipeName: it.recipeSuggestion })) again(); } }) : null);
    const dated = it.activeFrom || it.activeUntil ? h('div', { class: 'row tight wrap' },
      h('span', { class: 'tag blue', text: [it.activeFrom ? `on the list from ${shortDate(it.activeFrom)}` : '', it.activeUntil ? `last day ${shortDate(it.activeUntil)}` : ''].filter(Boolean).join(' · ') }),
      h('button', { class: 'link', text: 'Clear dates', onclick: async () => { if (await save(`/api/prep/items/${it.id}`, { activeFrom: null, activeUntil: null })) again(); } })) : null;
    const bulkFields = it.kind === 'batch' ? h('div', { class: 'row tight wrap' }, h('span', { class: 'small muted', text: 'Kept in' }), bulkUnit, h('span', { class: 'small muted', text: 'one batch makes' }), batchYield, h('span', { class: 'small muted', text: it.bulkUnit ?? '' })) : null;
    const base = (n) => n.replace(/\(.*?\)/g, '').trim().toLowerCase().replace(/s$/, '');
    const likely = !it.sourceItemId && others.find((b) => base(b.name) === base(it.name));
    const link = it.kind === 'count' && others.length ? h('div', { class: 'row tight wrap' }, h('span', { class: 'small muted', text: 'Filled from' }), source,
      likely ? h('button', { class: 'btn small-btn blue', text: `Link to ${likely.name}?`, onclick: async () => { if (await save(`/api/prep/items/${it.id}`, { sourceItemId: likely.id })) again(); } }) : null,
      it.sourceItemId ? h('span', { class: 'row tight' }, h('span', { class: 'small muted', text: `one ${it.unit ?? 'container'} holds` }), holds, h('span', { class: 'small muted', text: sourceItem?.bulk_unit ?? '(set the bulk item’s unit)' })) : null) : null;
    // One line for what it is (name, unit, par, kind, order), one small line for the rest.
    return h('div', { class: 'editrow compact' },
      h('div', { class: 'edit-main' }, name, unit, par, kind,
        editTools(() => move(s.items, i, -1, 'items'), () => move(s.items, i, 1, 'items'), it.name, async () => { if (await save(`/api/prep/items/${it.id}`, { active: false })) again(); })),
      h('div', { class: 'edit-more' },
        h('div', { class: 'row tight' }, h('span', { class: 'small muted', text: days.length ? 'Only on' : 'Every day, or only' }), dayChips),
        recipeRow, link, bulkFields, dated));
  };
  const checkRow = (c, i, list) => {
    const name = h('input', { type: 'text', value: c.name, 'aria-label': 'Task' });
    const freq = h('select', { 'aria-label': 'How often' }, [['daily', 'Daily'], ['weekly', 'Weekly']].map(([k, t]) => h('option', { value: k, text: t, selected: c.frequency === k ? true : undefined })));
    for (const el of [name, freq]) el.addEventListener('change', async () => { if (await save(`/api/prep/checklist/${c.id}`, { name: name.value, frequency: freq.value })) again(); });
    return h('div', { class: 'editrow compact' },
      h('div', { class: 'edit-main tasks' }, name, freq,
        editTools(() => move(list, i, -1, 'checklist'), () => move(list, i, 1, 'checklist'), c.name, async () => { if (await save(`/api/prep/checklist/${c.id}`, { active: false })) again(); })));
  };
  const newItem = h('input', { type: 'text', placeholder: 'New item', 'aria-label': 'New item' });
  const newTask = h('input', { type: 'text', placeholder: 'New cleaning task', 'aria-label': 'New cleaning task' });
  show(shell(me, 'prep', [
    h('header', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'kicker', text: 'Edit list' }), h('h1', { text: s.station.name }),
      h('div', { class: 'sub', text: 'Changes save as you go. Par is the busiest day’s par; other days are scaled to their sales.' })),
      h('button', { class: 'btn', text: '← Stations', onclick: () => prepHome(me) })),
    page([alertLine, h('section', { class: 'card' }, h('div', { class: 'row wrap' }, h('h2', { class: 'grow', text: 'Prep items' }),
        s.items.some((it) => it.recipeSuggestion) ? h('button', { class: 'btn small-btn', text: `Tie ${s.items.filter((it) => it.recipeSuggestion).length} to the suggested recipes`, title: 'So the recipe opens from the prep list', onclick: async () => {
          for (const it of s.items.filter((x) => x.recipeSuggestion)) await save(`/api/prep/items/${it.id}`, { recipeName: it.recipeSuggestion });
          again();
        } }) : null),
      h('div', { class: 'small muted', text: 'Items tied to a recipe show a Recipe button on the prep list.' }),
      h('div', { class: 'list' }, s.items.map(itemRow)),
      h('div', { class: 'row' }, newItem, h('button', { class: 'btn dark', text: 'Add', onclick: async () => { if (newItem.value.trim() && await save(`/api/prep/${stationId}/items`, { name: newItem.value, kind: 'count' })) again(); } }))),
    h('section', { class: 'card' }, h('h2', { text: 'Cleaning tasks' }),
      h('div', { class: 'list' }, s.checklist.map((c, i) => checkRow(c, i, s.checklist))),
      h('div', { class: 'row' }, newTask, h('button', { class: 'btn dark', text: 'Add', onclick: async () => { if (newTask.value.trim() && await save(`/api/prep/${stationId}/checklist`, { name: newTask.value, frequency: 'daily' })) again(); } })))], [
      sideBox('On this list', h('div', { class: 'list compact' },
        h('div', {}, h('span', { class: 'grow', text: 'Prep items' }), h('b', { text: String(s.items.length) })),
        h('div', {}, h('span', { class: 'grow', text: 'Tied to a recipe' }), h('b', { text: String(s.items.filter((it) => it.recipeName).length) })),
        h('div', {}, h('span', { class: 'grow', text: 'Cleaning tasks' }), h('b', { text: String(s.checklist.length) })))),
      sideBox('Kinds', h('div', { class: 'stack small' },
        h('div', {}, h('b', { text: 'Count' }), h('span', { class: 'muted', text: ': counted at night against its par; the app suggests what to make.' })),
        h('div', {}, h('b', { text: 'Daily task' }), h('span', { class: 'muted', text: ': on the list every day, nothing to count.' })),
        h('div', {}, h('b', { text: 'Bulk, as needed' }), h('span', { class: 'muted', text: ': made in batches; suggested when the station items it fills run low.' })))),
      sideBox('Par', h('div', { class: 'small muted', text: 'Par is the busiest day’s. Other days are scaled to their sales, so a quiet Tuesday asks for less.' })),
    ]),
  ]));
}

// Settings card: load station lists from a prep-lists file.
async function prepImportCard() {
  const box = h('section', { class: 'card', 'aria-label': 'Prep lists' });
  const err = h('div', { class: 'error' });
  const input = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Prep-lists file' });
  const button = h('button', { class: 'btn dark', text: 'Import', onclick: async () => {
      const file = input.files?.[0];
      if (!file) return (err.textContent = 'Choose the file first.');
      let data;
      try { data = JSON.parse(await file.text()); } catch { return (err.textContent = 'That file isn’t readable JSON.'); }
      button.disabled = true;
      const res = await api('POST', '/api/prep/import', data);
      button.disabled = false;
      if (!res.ok) return (err.textContent = res.data.error ?? 'Import failed.');
      box.append(h('div', { class: 'tag ok', text: `Loaded ${res.data.stations} stations, ${res.data.items} items` }));
    } });
  fill(box, h('h2', { text: 'Prep lists' }),
    h('div', { class: 'small muted', text: 'Load station prep lists from a prep-lists file. Importing a station again replaces its list (past days stay as they were).' }),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, input), button), err);
  return box;
}

// ------------------------------------------------------------------ menu

async function menuScreen(me) {
  loadingScreen(me, 'menu', 'Menu');
  const side = sideOf(me);
  const r = await api('GET', `/api/menu?area=${side}`);
  if (!r.ok) return show(shell(me, 'menu', [h('h1', { text: 'Menu' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const m = r.data;
  const manager = atLeast(me.roleLevel, 'manager');
  const since = (d) => (d <= m.from ? `before ${shortDate(m.from)}` : `since ${shortDate(d)}`);
  const baseOf = (section) => section.replace(/ add-ons$/, '');
  const sections = [...new Set(m.current.map((x) => baseOf(x.section)))];
  // "Needs card" opens a new card already named and linked to the button that sells it.
  const writeCard = async (x) => {
    const d = (await api('GET', `/api/cards?area=${side}`)).data;
    cardEditor(me, d, null, { name: x.pos?.itemName ?? x.name, kind: side === 'bar' ? 'drink' : 'dish', link: x.pos ? [{ ...x.pos, name: x.name }] : [] });
  };
  // Any change saves, then the page comes back with fresh numbers (staying on the same chip).
  // The spinner stays on the button until it's saved; then that line folds away and the page refreshes where it is.
  const save = (el, path, body, row) => pageAction(async () => {
    pressed = null;
    busy(el, true);
    const res = await api('POST', path, body);
    if (!res.ok) { busy(el, false); return (row ?? el.parentNode).append(h('div', { class: 'error small', text: res.data.error ?? 'Not saved.' })); }
    await foldAway(row === undefined ? el.closest('.ask, .list > div') : row);
    refreshInPlace(() => menuScreen(me));
  });
  // Same drink, different price: discount buttons folded in show under the drink, each can be kept apart;
  // a button the name doesn't give away can be folded into another variation of the same item by hand.
  const priceVariation = (el, body) => save(el, '/api/menu/price-variation', body, null);
  const siblings = (x) => (x.pos?.variationName ? m.current.filter((o) => o !== x && o.pos && o.pos.itemName === x.pos.itemName && o.pos.catalogId !== x.pos.catalogId) : []);
  const includesLine = (x) => (x.includes?.length ? h('div', { class: 'small muted includes' }, 'Includes ', x.includes.map((v, n) => [n ? ', ' : '',
    h('span', { text: `${v.variationName || v.name} (${Math.round(v.quantity)} sold)` }), ' ',
    h('button', { class: 'link', text: 'Keep apart', title: `Show ${v.name} as its own item`, onclick: (e) => priceVariation(e.currentTarget, { catalogId: v.catalogId, action: 'split' }) })])) : null);
  const sameAs = (x) => {
    const sib = siblings(x);
    if (!sib.length || !manager) return null;
    const pick = h('select', { class: 'small-select', 'aria-label': `${x.name} is the same drink as` }, h('option', { value: '', text: 'Same drink as…' }), sib.map((o) => h('option', { value: o.pos.catalogId, text: o.name })));
    pick.addEventListener('change', () => pick.value && priceVariation(pick, { catalogId: x.pos.catalogId, action: 'merge', into: pick.value }));
    return pick;
  };
  const setStatus = (el, x, status, date) => save(el, '/api/menu/status', { menuKey: x.menuKey, status, name: x.name, ...(date ? { date } : {}) });
  // Taking a dish off: the choice opens in its row (from today, or from its last sale), and the row folds away once saved.
  const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return iso(d); })();
  const takeOff = (x, row, actions) => {
    const offFrom = x.lastSold && x.lastSold < yesterday ? x.lastSold : null;
    fill(actions, h('span', { class: 'small muted', text: 'Off the menu:' }),
      h('button', { class: 'btn small-btn dark', text: 'From today', onclick: (e) => setStatus(e.currentTarget, x, 'off', x.lastSold && x.lastSold > yesterday ? x.lastSold : yesterday) }),
      offFrom ? h('button', { class: 'btn small-btn', text: `Since its last sale, ${shortDate(offFrom)}`, onclick: (e) => setStatus(e.currentTarget, x, 'off', offFrom) }) : null,
      h('button', { class: 'link', text: 'Cancel', onclick: () => fill(actions, normalActions(x, row, actions)) }));
    actions.querySelector('.btn')?.focus();
  };
  const normalActions = (x, row, actions) => [
    x.hasCard || !flagCards ? null : h('button', { class: 'tag warn tag-button', text: 'needs recipe', title: `Write the recipe for ${x.name}`, onclick: () => writeCard(x) }),
    h('span', { class: 'small muted nowrap', text: since(x.since) }),
    manager && x.menuKey ? h('button', { class: 'link take-off', text: 'Take off', title: `Take ${x.name} off the menu`, onclick: () => takeOff(x, row, actions) }) : null];
  const flagCards = m.cards;
  const dishRow = (x) => {
    const actions = h('div', { class: 'row-actions' });
    const row = h('div', {}, photo(x.image, 'thumb small'), h('div', { class: 'grow' }, h('div', { text: x.name }), includesLine(x)), sameAs(x),
      x.quiet ? h('button', { class: 'tag ask tag-button', text: 'quiet', title: `Hasn’t sold since ${shortDate(x.quiet.since)}: still on?`, onclick: () => pickChip('needs') }) : null,
      actions);
    fill(actions, normalActions(x, row, actions));
    return row;
  };

  // Questions: about what's selling, and quiet dishes (still on, or came off?).
  const answer = (body, row, el) => pageAction(async () => {
    pressed = null;
    row.querySelectorAll('button, select').forEach((b) => (b.disabled = true));
    busy(el, true);
    const res = await api('POST', '/api/answers', body);
    if (!res.ok) {
      busy(el, false);
      row.querySelectorAll('button, select').forEach((b) => (b.disabled = false));
      return row.append(h('div', { class: 'error', text: res.data.error ?? 'That didn’t save.' }));
    }
    await foldAway(row);
    refreshInPlace(() => menuScreen(me));
  });
  const choices = (row, buttons) => h('div', { class: 'row wrap' }, buttons.map(([label, body, cls]) => h('button', { class: `btn small-btn${cls ? ' ' + cls : ''}`, text: label, onclick: (e) => answer(body, row, e.currentTarget) })));
  const otherCard = (row, item) => {
    const select = h('select', { 'aria-label': 'Another recipe', onchange: () => select.value && answer({ type: 'link', ...item, recipe: select.value }, row, select) },
      h('option', { value: '', text: 'Another recipe…' }), (m.recipes ?? []).map((r) => h('option', { value: r, text: r })));
    return select;
  };
  const onlyPrep = (q) => q.candidates.length > 0 && (q.candidateKinds ?? []).length > 0 && q.candidateKinds.every((k) => k === 'prep');
  const questionRows = [
    ...m.checks.filter((c) => c.kind !== 'notSelling').map((c) => {
      const row = h('div', { class: 'ask' });
      const buttons = [];
      if (c.kind === 'dishChanged' && c.item) buttons.push([`Yes, new version from ${shortDate(c.suggestedDate)}`, { type: 'newDish', ...c.item, from: c.suggestedDate, note: 'new version, recipe to come' }, 'dark'], ['No, same dish', { type: 'dismiss', dedupeKey: c.dedupeKey, note: c.title }]);
      else if (c.kind === 'newButton' && c.item) buttons.push(['New dish, recipe to come', { type: 'newDish', ...c.item }, 'dark'], ['Not food', { type: 'notFood', ...c.item }], ['Ignore', { type: 'dismiss', dedupeKey: c.dedupeKey, note: c.title }]);
      else buttons.push(['Ignore', { type: 'dismiss', dedupeKey: c.dedupeKey, note: c.title }]);
      row.append(h('div', { text: c.title }), choices(row, buttons));
      return row;
    }),
    ...m.linkQuestions.map((q) => {
      const row = h('div', { class: 'ask' });
      const sold = q.first ? ` · sold ${shortDate(q.first)} – ${shortDate(q.last)}` : '';
      row.append(
        h('div', {}, h('b', { text: q.name }), h('span', { class: 'small muted', text: ` ${dollars(q.netSales)}${sold}` })),
        h('div', { class: 'small muted', text: !q.candidates.length ? 'No recipe matches.' : onlyPrep(q) ? 'Only a prep recipe matches. A prep is a batch (a sauce, a dough), not what’s sold, so this usually needs its own recipe.' : 'Which recipe is it?' }),
        choices(row, [...q.candidates.map((c, i) => [q.candidateKinds?.[i] === 'prep' ? `${c} (prep recipe)` : c, { type: 'link', ...q.item, recipe: c }, i === 0 && !onlyPrep(q) ? 'dark' : '']), [onlyPrep(q) ? 'Needs its own recipe' : 'New dish, recipe to come', { type: 'newDish', ...q.item }, onlyPrep(q) ? 'dark' : ''], ['Not food', { type: 'notFood', ...q.item }]]),
      );
      row.lastChild.append(otherCard(row, q.item));
      return row;
    }),
  ];
  // Quiet: still on the menu but not selling for longer than usual for it. Nothing comes off without a yes.
  const quiet = m.current.filter((x) => x.quiet).sort((a, b) => a.quiet.since.localeCompare(b.quiet.since));
  const longQuiet = quiet.filter((x) => (Date.now() - Date.parse(`${x.quiet.since}T12:00:00`)) / 86_400_000 > 28);
  const quietRow = (x) => {
    const row = h('div', { class: 'ask' });
    const other = h('input', { type: 'date', max: iso(new Date()), min: x.since, value: x.quiet.since, 'aria-label': `Day ${x.name} came off` });
    const otherBox = h('div', { class: 'row tight' }, other, h('button', { class: 'btn small-btn', text: 'Save', onclick: (e) => other.value && setStatus(e.currentTarget, x, 'off', other.value) }));
    otherBox.hidden = true;
    row.append(
      h('div', {}, h('b', { text: x.name }), h('span', { class: 'small muted', text: ` · ${x.section} · last sold ${shortDate(x.quiet.since)}${x.quiet.after ? `; it’s asked about after ${x.quiet.after} quiet days` : ''}` })),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn small-btn dark', text: 'Still on', onclick: (e) => setStatus(e.currentTarget, x, 'stillOn') }),
        h('button', { class: 'btn small-btn', text: `Came off ${shortDate(x.quiet.since)}`, onclick: (e) => setStatus(e.currentTarget, x, 'off', x.quiet.since) }),
        h('button', { class: 'link', text: 'Another day…', onclick: () => { otherBox.hidden = false; other.focus(); } })),
      otherBox);
    return row;
  };
  const quietCard = quiet.length ? h('section', { class: 'card' },
    h('div', { class: 'row wrap' }, h('h2', { class: 'grow', text: `Still on the menu? (${quiet.length})` }),
      longQuiet.length > 1 ? h('button', { class: 'btn small-btn', text: `${longQuiet.length} quiet 4+ weeks: came off`, title: 'Each on the last day it sold', onclick: (e) => {
        if (!confirmText(`Mark these ${longQuiet.length} as off the menu, each from the last day it sold?\n\n${longQuiet.map((x) => x.name).join(', ')}`)) return;
        save(e.currentTarget, '/api/menu/status', { items: longQuiet.map((x) => ({ menuKey: x.menuKey, status: 'off', date: x.quiet.since, name: x.name })) });
      } }) : null),
    h('div', { class: 'small muted', text: 'These haven’t sold for longer than usual for them. They stay on the menu until you say otherwise.' }),
    h('div', { class: 'asks' }, quiet.map(quietRow))) : null;
  const needCount = questionRows.length + quiet.length;

  // Chips: one per category, then Needs you and Coming up. The choice is remembered on this device.
  const chipKey = `menuChip:${side}`;
  const canPlan = atLeast(me.roleLevel, 'chef') && side === 'kitchen';
  const valid = (k) => k === 'needs' ? needCount > 0 : k === 'coming' ? canPlan : sections.includes(k);
  let chip = recall(chipKey);
  if (!valid(chip)) chip = needCount ? 'needs' : sections[0] ?? (canPlan ? 'coming' : 'needs');
  let coming = null;
  const pickChip = (k) => { chip = k; remember(chipKey, k); draw(); };

  // The side: what's on, what came off (each can be put back), adding a dish back, buttons kept apart, answers.
  const offBox = m.cameOff.length ? sideBox('Came off', h('div', { class: 'list compact' }, m.cameOff.slice(0, 15).map((x) => h('div', {},
    h('span', { class: 'grow', text: x.name }), h('span', { class: 'small muted nowrap', text: `${shortDate(x.from)} – ${shortDate(x.to)}` }),
    manager && x.menuKey ? h('button', { class: 'link', text: 'Put back', title: `${x.name} is still on the menu`, onclick: (e) => setStatus(e.currentTarget, x, 'on') }) : null)))) : null;
  const addBack = manager && m.addable?.length ? (() => {
    const pick = h('select', { 'aria-label': 'A dish to put back on the menu' }, h('option', { value: '', text: 'Pick a recipe…' }),
      m.addable.map((x, i) => h('option', { value: String(i), text: `${x.name}${x.section === 'Not sold yet' ? ' (not sold yet)' : ` · ${x.section}`}` })));
    const btn = h('button', { class: 'btn small-btn dark', text: 'Put on the menu', onclick: () => pick.value && setStatus(btn, m.addable[Number(pick.value)], 'on') });
    return sideBox('Missing a dish?', h('div', { class: 'small muted', text: 'Put a recipe back on the menu, from today. It stays on until you take it off.' }), pick, sideActions(btn));
  })() : null;
  const keptBox = m.priceKept?.length ? sideBox('Kept as their own item', h('div', { class: 'list compact' }, m.priceKept.map((k) => h('div', {},
    h('span', { class: 'grow small', text: k.kind === 'merge' ? `${k.name} → same as ${k.into}` : k.name }),
    h('button', { class: 'link', text: k.kind === 'merge' ? 'Undo' : 'Fold back', onclick: (e) => priceVariation(e.currentTarget, { catalogId: k.catalogId, action: 'reset' }) })))),
    h('div', { class: 'small muted', text: 'Discount buttons (Tuesday $10, half-price Wednesday) count as the drink they discount, unless kept apart here.' })) : null;
  const needCard = m.cards ? m.current.filter((x) => !x.hasCard).length : 0;
  const answers = manager ? answersBox(me, () => refreshInPlace(() => menuScreen(me))) : null;

  async function draw() {
    const chips = h('div', { class: 'chips-row', role: 'tablist', 'aria-label': 'Show' },
      sections.map((sec) => h('button', { class: `chip${chip === sec ? ' on' : ''}`, role: 'tab', 'aria-selected': String(chip === sec), onclick: () => pickChip(sec) },
        sec, h('span', { class: 'chip-count', text: String(m.current.filter((x) => baseOf(x.section) === sec).length) }))),
      needCount ? h('button', { class: `chip needs${chip === 'needs' ? ' on' : ''}`, role: 'tab', 'aria-selected': String(chip === 'needs'), onclick: () => pickChip('needs') }, 'Needs you', h('span', { class: 'chip-count', text: String(needCount) })) : null,
      canPlan ? h('button', { class: `chip${chip === 'coming' ? ' on' : ''}`, role: 'tab', 'aria-selected': String(chip === 'coming'), onclick: () => pickChip('coming') }, 'Coming up') : null);
    let main;
    if (chip === 'needs') {
      main = [quietCard, questionRows.length ? h('section', { class: 'card', id: 'menu-questions' },
        h('div', { class: 'row' }, h('h2', { class: 'grow', text: `About what’s selling (${questionRows.length})` }), h('span', { class: 'small muted', text: 'Answers update margins straight away.' })),
        h('div', { class: 'asks' }, questionRows)) : null];
      if (!quietCard && !questionRows.length) main = [h('section', { class: 'card small muted', text: 'Nothing needs you.' })];
    } else if (chip === 'coming') {
      coming ??= await comingUpCard(me);
      main = [coming ?? h('section', { class: 'card small muted', text: 'Couldn’t load what’s coming up.' })];
    } else {
      const parts = [...new Set(m.current.filter((x) => baseOf(x.section) === chip).map((x) => x.section))];
      main = parts.map((sec) => h('section', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { class: 'grow', text: sec }), h('span', { class: 'small muted', text: String(m.current.filter((x) => x.section === sec).length) })),
        h('div', { class: 'list' }, m.current.filter((x) => x.section === sec).map((x) => dishRow(x)))));
    }
    const onMenu = sideBox('On the menu now', h('div', { class: 'list compact' },
      sections.map((sec) => h('div', {}, h('button', { class: 'linkish grow', text: sec, onclick: () => pickChip(sec) }), h('b', { text: String(m.current.filter((x) => baseOf(x.section) === sec).length) })))),
      needCard ? h('div', { class: 'small muted', text: `${needCard} without a recipe.` }) : null,
      sideActions(h('button', { class: 'btn small-btn', text: 'Recipe costs', onclick: () => cardsScreen(me) })));
    show(shell(me, 'menu', [
      h('header', { class: 'row wrap' },
        h('div', { class: 'grow' }, h('div', { class: 'kicker', text: `${AREA_NAMES[side]} · from Square sales since ${shortDate(m.from)}` }), h('h1', { text: side === 'bar' ? 'Bar menu' : 'Menu' }),
          h('div', { class: 'sub', text: 'What’s selling. A dish only comes off when you say so; quiet ones are asked about under Needs you.' })),
        sideSwitch(me, () => menuScreen(me))),
      chips,
      page([missingNote(m.missing), main],
        [m.coverage ? coverageCard(me, m.coverage, side) : null, onMenu, addBack, offBox, keptBox, answers]),
    ]));
  }
  draw();
}

/** What an answer said, in a line. */
function answerText(a) {
  if (a.type === 'link') return [h('b', { text: a.name }), ' is the ', h('b', { text: a.recipe }), ' recipe'];
  if (a.type === 'newDish') return [h('b', { text: a.name }), a.note === 'unlinked in the app' ? ': taken off its recipe' : a.target.from ? `: new version from ${shortDate(a.target.from)}` : ': new dish, recipe to come'];
  if (a.type === 'notFood') return [h('b', { text: a.name }), ': not food'];
  if (a.type === 'menuOff') return [h('b', { text: a.name }), `: came off the menu ${a.date ? shortDate(a.date) : ''}`];
  if (a.type === 'menuOn') return [h('b', { text: a.name }), ': put back on the menu'];
  if (a.type === 'stillOn') return [h('b', { text: a.name }), ': still on the menu'];
  return [h('b', { text: a.name.replace(/[.?]$/, '') }), ': ignored'];
}

/**
 * Answers given to the menu questions, newest first, each with Undo: taking one back asks the question again.
 * Fills in after the page is up, so it never holds the page back.
 */
function answersBox(me, redraw) {
  const list = h('div', { class: 'list compact answers' }, h('div', { class: 'small muted', text: 'Loading…' }));
  const more = h('div');
  const load = async (limit) => {
    const r = await api('GET', `/api/answers/recent?limit=${limit}`);
    if (!r.ok) return fill(list, h('div', { class: 'small muted', text: 'Couldn’t load them.' }));
    if (!r.data.answers.length) return fill(list, h('div', { class: 'small muted', text: 'None yet.' }));
    fill(list, r.data.answers.map((a) => {
      const undo = h('button', { class: 'link', text: 'Undo', 'aria-label': `Undo: ${a.name}` });
      const row = h('div', {}, h('div', { class: 'grow' }, h('div', { class: 'small' }, answerText(a)),
        a.at || a.by ? h('div', { class: 'small muted', text: [a.at ? shortDate(a.at.slice(0, 10)) : '', a.by ?? ''].filter(Boolean).join(' · ') }) : null), undo);
      undo.addEventListener('click', () => pageAction(async () => {
        busy(undo, true);
        const res = await api('POST', '/api/answers/undo', { target: a.target });
        if (!res.ok) { busy(undo, false); return row.append(h('div', { class: 'error small', text: res.data.error ?? 'Not undone.' })); }
        await foldAway(row);
        redraw();
      }));
      return row;
    }));
    fill(more, r.data.total > r.data.answers.length ? h('button', { class: 'btn small-btn', text: `Show all ${r.data.total}`, onclick: (e) => { busy(e.currentTarget, true); load(500); } }) : null);
  };
  load(8);
  return sideBox('Answers given', h('div', { class: 'small muted', text: 'Undo one and its question comes back, to answer again.' }), list, more);
}

// Dishes coming to the menu: plan ahead, see what prep it means, apply to the station lists.
async function comingUpCard(me) {
  const box = h('section', { class: 'card', 'aria-label': 'Coming up' });
  const r = await api('GET', '/api/plans');
  if (!r.ok) return null;
  const p = r.data;
  const err = h('div', { class: 'error' });
  const name = h('input', { type: 'text', placeholder: 'Dish name', 'aria-label': 'Dish name' });
  const starts = h('input', { type: 'date', 'aria-label': 'Starts on', min: p.today });
  const card = h('select', { 'aria-label': 'Recipe' }, h('option', { value: '', text: 'No recipe yet' }), p.dishCards.map((n) => h('option', { value: n, text: n })));
  const replaces = h('select', { 'aria-label': 'Replaces' }, h('option', { value: '', text: 'Adds to the menu' }), p.currentDishes.map((n) => h('option', { value: n, text: `Replaces ${n}` })));
  const form = h('div', { class: 'row wrap' }, name, starts, card, replaces, h('button', { class: 'btn dark', text: 'Plan it', onclick: async () => {
      const res = await api('POST', '/api/plans', { name: name.value, startsOn: starts.value, recipeName: card.value, replaces: replaces.value });
      if (!res.ok) return (err.textContent = res.data.error ?? 'Not saved.');
      menuScreen(me);
    } }));
  const planRows = p.plans.map((plan) => {
    const row = h('div', { class: 'ask' });
    const head = h('div', {}, h('b', { text: plan.name }), h('span', { class: 'small muted', text: ` · starts ${shortDate(plan.startsOn)}${plan.replaces ? ` · replaces ${plan.replaces}` : ''}${plan.recipeName ? '' : ' · no recipe yet'}` }),
      plan.status === 'applied' ? h('span', { class: 'tag ok', text: 'On the prep lists' }) : null);
    row.append(head);
    if (plan.status !== 'planned') return row;
    const pr = plan.proposal;
    const adds = [];
    const lines = pr.preps.map((x) => {
      if (x.onStations.length) return h('div', { class: 'small', text: `✓ ${x.recipe}: already on ${x.onStations.map((o) => `${o.station} (${o.item})`).join(', ')}` });
      const on = h('input', { type: 'checkbox', checked: true, 'aria-label': `Add ${x.recipe}` });
      const st = h('select', { 'aria-label': 'Station' }, p.stations.map((s) => h('option', { value: s.id, text: s.name, selected: s.id === pr.likelyStation ? true : undefined })));
      const unit = h('input', { type: 'text', class: 'unit-in', placeholder: 'unit', 'aria-label': 'Unit' });
      const par = h('input', { inputmode: 'decimal', class: 'amount', placeholder: 'par', 'aria-label': 'Par' });
      adds.push(() => (on.checked ? { recipeName: x.recipe, stationId: st.value, unit: unit.value, par: par.value } : null));
      return h('div', { class: 'row tight wrap' }, on, h('span', { text: `Add ${x.recipe} to` }), st, unit, par);
    });
    const ends = [];
    const endLines = (pr.replaced?.exclusive ?? []).flatMap((x) => x.items.map((it) => {
      const on = h('input', { type: 'checkbox', checked: true, 'aria-label': `End ${it.item}` });
      ends.push(() => (on.checked ? it.id : null));
      return h('div', { class: 'row tight' }, on, h('span', { text: `Take ${it.item} off ${it.station} (only ${pr.replaced.name} used it)` }));
    }));
    const note = pr.replaced?.soldPerDay ? h('div', { class: 'small muted', text: `${pr.replaced.name} sold ${pr.replaced.soldPerDay} a day: a fair first guess for the new dish’s pars.` }) : null;
    row.append(...[
      lines.length ? h('div', { class: 'stack' }, lines) : h('div', { class: 'small muted', text: plan.recipeName ? 'Its recipe uses no preps.' : 'Add its recipe to see the prep it needs; you can still add preps by hand under Prep → Edit list.' }),
      endLines.length ? h('div', { class: 'stack' }, endLines) : null, note,
      h('div', { class: 'row tight' },
        h('button', { class: 'btn small-btn dark', text: 'Put on the prep lists', onclick: async () => {
          const res = await api('POST', `/api/plans/${plan.id}/apply`, { add: adds.map((f) => f()).filter(Boolean), end: ends.map((f) => f()).filter(Boolean) });
          if (!res.ok) return row.append(h('div', { class: 'error', text: res.data.error ?? 'Not applied.' }));
          menuScreen(me);
        } }),
        h('button', { class: 'link', text: 'Cancel plan', onclick: async () => { await api('POST', `/api/plans/${plan.id}`, { cancel: true }); menuScreen(me); } })),
      h('div', { class: 'small muted', text: `New preps go on the lists from ${shortDate(new Date(Date.parse(plan.startsOn) - 86400000).toISOString().slice(0, 10))}, the day before it starts.` })].filter(Boolean));
    return row;
  });
  fill(box, h('h2', { text: 'Coming up' }),
    h('div', { class: 'small muted', text: 'Plan a dish before it sells: its preps join the station lists the day before it starts, and the old dish’s own preps come off.' }),
    form, err, planRows.length ? h('div', { class: 'asks' }, planRows) : null);
  return box;
}

// ------------------------------------------------------------------ recipe book

/** The book: Kitchen | Bar, then sections (what sells most first, preps last), then cards. */
async function recipesScreen(me, state = {}) {
  loadingScreen(me, 'recipes', 'Recipes');
  const r = await api('GET', '/api/recipes');
  if (!r.ok) return show(shell(me, 'recipes', [h('h1', { text: 'Recipes' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const side = sideOf(me);
  const q = (state.q ?? '').trim().toLowerCase();
  const sections = (q ? [...r.data.kitchen, ...r.data.bar] : r.data[side])
    .map((s) => ({ ...s, cards: s.cards.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.sellsAs ?? '').toLowerCase().includes(q)) }))
    .filter((s) => s.cards.length);
  const search = h('input', { type: 'search', placeholder: 'Find a recipe', 'aria-label': 'Find a recipe', value: state.q ?? '', class: 'search' });
  search.addEventListener('input', () => { clearTimeout(search.timer); search.timer = setTimeout(() => { recipesScreen(me, { q: search.value }).then(() => { const s = document.querySelector('input.search'); s?.focus(); s?.setSelectionRange(s.value.length, s.value.length); }); }, 250); });
  // Down the side: the sections to jump to, how much of the menu has cards, and (managers) the cards themselves.
  const all = r.data[side];
  const count = (pred) => all.reduce((a, sec) => a + sec.cards.filter(pred).length, 0);
  const preps = count((c) => c.kind === 'prep' || c.kind === 'barPrep');
  const contents = q ? null : sideBox('In the book', h('div', { class: 'picks' }, all.map((sec) => h('button', { class: 'pick', onclick: () => document.getElementById(`sec-${sec.section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
    h('span', { class: 'grow', text: sec.section }), h('span', { class: 'small muted', text: String(sec.cards.length) })))),
    h('div', { class: 'small muted', text: `${count(() => true) - preps} ${side === 'bar' ? 'drinks' : 'dishes'} and ${preps} preps. Tap one to read it; a prep in it opens its own recipe.` }));
  const coverage = !q && r.data.coverage?.[side] ? coverageCard(me, r.data.coverage[side], side) : null;
  const manager = atLeast(me.roleLevel, 'manager');
  const newRecipe = manager ? h('button', { class: 'btn dark', text: 'New recipe', onclick: async () => { const d = (await api('GET', `/api/cards?area=${side}`)).data; cardEditor(me, d, null, { kind: side === 'bar' ? 'drink' : 'dish', back: { label: 'Recipes', go: (saved) => (saved ? recipePage(me, saved) : recipesScreen(me)), rail: 'recipes' } }); } }) : null;
  const tools = manager ? sideBox('Recipe costs', h('div', { class: 'small muted', text: 'What each recipe costs from your invoice prices, and its share of the price.' }),
    sideActions(h('button', { class: 'btn small-btn', text: 'Recipe costs', onclick: () => cardsScreen(me) }))) : null;
  show(shell(me, 'recipes', [
    h('header', { class: 'row wrap' },
      h('div', { class: 'grow' }, h('div', { class: 'kicker', text: q ? 'Kitchen and bar' : AREA_NAMES[side] }), h('h1', { text: 'Recipes' })),
      h('div', { class: 'row wrap' }, search, q ? null : sideSwitch(me, () => recipesScreen(me)), newRecipe)),
    page(sections.length ? h('div', { class: 'book' }, sections.map((s) => h('section', { class: 'card', id: `sec-${s.section}` },
      h('div', { class: 'row' }, h('h2', { class: 'grow', text: s.section }), h('span', { class: 'small muted', text: String(s.cards.length) })),
      h('div', { class: 'book-list' }, s.cards.map((c) => h('button', { class: `book-item${c.image ? ' with-photo' : ''}`, onclick: () => recipePage(me, c.name) },
        photo(c.image), h('span', { text: c.name }))))))
    ) : h('div', { class: 'card small muted', text: q ? 'No recipe by that name.' : `No ${side === 'bar' ? 'drink' : ''} recipes yet.` }),
    [contents, coverage, tools]),
  ]));
}

/** One card, on its own page in the book. */
async function recipePage(me, name, opts = {}) {
  const r = await api('GET', `/api/recipes/${encodeURIComponent(name)}`);
  if (!r.ok) return show(shell(me, 'recipes', [h('h1', { text: name }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const v = recipeView(me, r.data, { open: (n) => recipePage(me, n), back: h('button', { class: 'btn', text: '← Recipes', onclick: () => recipesScreen(me) }), page: true, reload: () => refreshInPlace(() => recipePage(me, name, opts)), ...opts });
  show(shell(me, 'recipes', [v.head, page(v.body, v.side)]));
}

/** A card over whatever's on screen (a prep list), so nobody loses their place. */
async function recipeSheet(me, name, scaleTo, trail = []) {
  const q = scaleTo?.amount > 0 && scaleTo.unit ? `?amount=${scaleTo.amount}&unit=${encodeURIComponent(scaleTo.unit)}` : '';
  const r = await api('GET', `/api/recipes/${encodeURIComponent(name)}${q}`);
  document.querySelector('.sheet-wrap')?.remove();
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const back = trail.length ? h('button', { class: 'btn', text: `← ${trail[trail.length - 1].name}`, onclick: () => { const prev = trail[trail.length - 1]; recipeSheet(me, prev.name, prev.scaleTo, trail.slice(0, -1)); } }) : null;
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': name },
    h('div', { class: 'row' }, h('div', { class: 'grow' }, back), h('button', { class: 'btn', text: 'Close', onclick: close })),
    r.ok ? recipeView(me, r.data, { open: (n) => recipeSheet(me, n, undefined, [...trail, { name, scaleTo }]), sheet: true }) : h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' }));
  const wrap = h('div', { class: 'sheet-wrap', onclick: (e) => { if (e.target === wrap) close(); } }, panel);
  document.addEventListener('keydown', onKey);
  document.body.append(wrap);
  panel.querySelector('button')?.focus();
}

const nice = (n) => {
  if (!(n > 0)) return '0';
  const whole = Math.floor(n + 1e-9), frac = n - whole;
  const fr = [[0.25, '¼'], [1 / 3, '⅓'], [0.5, '½'], [2 / 3, '⅔'], [0.75, '¾']].find(([v]) => Math.abs(frac - v) < 0.02);
  if (frac < 0.02) return String(whole);
  if (fr) return `${whole || ''}${fr[1]}`;
  return n < 10 ? String(+n.toFixed(2)) : String(+n.toFixed(1));
};

function recipeView(me, r, opts) {
  let scale = r.scale ?? 1;
  const y = r.yields[0];
  const prep = r.kind === 'prep' || r.kind === 'barPrep';
  const page = Boolean(opts.page);
  const body = h('div', { class: 'recipe' });
  const side = page ? h('div', { class: 'page-side-boxes' }) : null;
  const makesText = () => (prep ? `Makes ${nice(y.amount * scale)} ${UNIT_LABEL(y.unit)}${r.yields.length > 1 ? ` (${r.yields.slice(1).map((x) => `${nice(x.amount * scale)} ${UNIT_LABEL(x.unit)}`).join(', ')})` : ''}` : r.kind === 'drink' ? 'One drink' : 'One plate');
  const sellsAs = r.sellsAs.filter((n) => n.toLowerCase() !== r.name.toLowerCase());
  const editButton = r.canEdit && !opts.sheet ? h('button', { class: 'btn', text: 'Edit recipe', onclick: async () => { const d = (await api('GET', '/api/cards')).data; const c = d.cards.find((x) => x.name === r.name); if (c) cardEditor(me, d, c, { back: { label: r.name, go: (saved) => recipePage(me, saved || c.name), rail: 'recipes' } }); } }) : null;
  const usedIn = () => (r.usedBy.length ? r.usedBy.map((n, k) => [k ? ', ' : '', h('button', { class: 'linkish card-link', text: n, onclick: () => opts.open(n) })]) : null);
  // The page's title row stays put; only the amounts change with the batch size.
  const head = page ? h('header', { class: 'row wrap' },
    h('div', { class: 'grow' }, h('div', { class: 'kicker', text: `${AREA_NAMES[r.side]} · ${r.section}` }), h('h1', { text: r.name }),
      h('div', { class: 'sub', text: [sellsAs.length ? `Sells as ${sellsAs.join(', ')}` : '', r.shelfLifeDays ? `keeps ${r.shelfLifeDays} days` : ''].filter(Boolean).join(' · ') || null })),
    opts.back ?? null, editButton) : null;
  const draw = () => {
    const sizes = [0.5, 1, 2, 3];
    const other = r.scaledTo && Math.abs(r.scale - 1) > 1e-6 && !sizes.includes(r.scale);
    const scaler = prep ? h('div', { class: 'seg', role: 'group', 'aria-label': 'How much to make' },
      sizes.map((k) => h('button', { class: Math.abs(scale - k) < 1e-6 ? 'on' : '', 'aria-pressed': String(Math.abs(scale - k) < 1e-6), 'aria-label': `${k} batch${k > 1 ? 'es' : ''}`,
        text: page ? (k === 0.5 ? '½' : String(k)) : k === 0.5 ? '½ batch' : k === 1 ? '1 batch' : `${k} batches`, onclick: () => { scale = k; draw(); } })),
      other ? h('button', { class: Math.abs(scale - r.scale) < 1e-6 ? 'on' : '', text: `For ${nice(r.scaledTo.amount)} ${UNIT_LABEL(r.scaledTo.unit)}`, onclick: () => { scale = r.scale; draw(); } }) : null) : null;
    const asked = r.asked && !r.scaledTo && prep ? h('div', { class: 'note', text: `The list says make ${nice(r.asked.amount)} ${UNIT_LABEL(r.asked.unit)}. This recipe is written in ${UNIT_LABEL(y.unit)}, so it shows one batch.` }) : null;
    const table = h('table', { class: 'ingredients' }, h('tbody', {}, r.ingredients.map((i) => h('tr', {},
      h('td', { class: 'amt', text: `${nice(i.amount * scale)} ${UNIT_LABEL(i.unit)}` }),
      h('td', {}, i.card ? h('button', { class: 'linkish card-link', text: i.card, onclick: () => opts.open(i.card) }) : h('span', { text: i.name }),
        i.yieldPercent ? h('span', { class: 'small muted', text: ` (after trimming; ${i.yieldPercent}% usable)` }) : null,
        i.note ? h('div', { class: 'small muted', text: i.note }) : null)))));
    const method = r.method ? h('div', { class: 'method' }, h('h3', { text: 'Method' }), r.method.split(/\n+/).map((p) => h('p', { text: p }))) : h('div', { class: 'small muted', text: r.canEdit && !opts.sheet ? 'No method written yet. Add one with Edit recipe.' : 'No method written yet.' });
    const cost = r.cost !== undefined ? `Costs ${money2(r.cost * scale)}${r.complete ? '' : ' (some lines have no price yet)'}` : null;
    if (page) {
      fill(body, asked, h('section', { class: 'card' }, h('h2', { text: makesText() }), table), h('section', { class: 'card' }, method));
      fill(side,
        r.image ? h('section', { class: 'card tight' }, photo(r.image, 'hero')) : null,
        prep ? sideBox('How much', h('div', { class: 'big', text: `${nice(y.amount * scale)} ${UNIT_LABEL(y.unit)}` }), scaler, h('div', { class: 'small muted', text: 'Batches: every amount scales with it.' })) : null,
        r.usedBy.length ? sideBox('Used in', h('div', { class: 'small' }, usedIn())) : null,
        r.linked ? soldAsBox(r, opts.reload) : null,
        cost ? sideBox('Cost · managers only', h('div', { class: 'big', text: money2(r.cost * scale) }), h('div', { class: 'small muted', text: `${prep ? `for ${nice(y.amount * scale)} ${UNIT_LABEL(y.unit)}` : r.kind === 'drink' ? 'a drink' : 'a plate'}${r.complete ? '' : ' · some lines have no price yet'}` })) : null);
      return;
    }
    fill(body,
      h('div', { class: 'row wrap' },
        h('div', { class: 'grow' }, h('div', { class: 'kicker', text: `${AREA_NAMES[r.side]} · ${r.section}` }), h('h2', { class: 'sheet-title', text: r.name }),
          h('div', { class: 'sub', text: [makesText(), sellsAs.length ? `sells as ${r.sellsAs.join(', ')}` : '', r.shelfLifeDays ? `keeps ${r.shelfLifeDays} days` : ''].filter(Boolean).join(' · ') })),
        opts.back ?? null, editButton),
      r.image ? photo(r.image, 'hero') : null,
      scaler, asked, table, method,
      r.usedBy.length ? h('div', { class: 'small' }, h('span', { class: 'muted', text: 'Used in ' }), usedIn()) : null,
      cost ? h('div', { class: 'small muted', text: `${cost} · managers only` }) : null);
  };
  draw();
  return page ? { head, body, side: [...side.children].length ? side : null } : body;
}

/** The Square buttons that sell this recipe (managers): each can be taken off, back to "selling without a recipe". */
function soldAsBox(r, reload) {
  const prep = r.kind === 'prep' || r.kind === 'barPrep';
  if (!r.linked.length) return prep ? null : sideBox('Sold as', h('div', { class: 'small muted', text: 'No Square button is linked to it yet.' }));
  return sideBox('Sold as', prep ? h('div', { class: 'note small', text: `This is a prep recipe (a batch), but a Square button is linked to it as if it were sold as is. If that's a mistake, unlink it: the button goes back to needing its own recipe.` }) : null,
    h('div', { class: 'list compact' }, r.linked.map((l) => {
      const btn = h('button', { class: 'link', text: 'Unlink', 'aria-label': `Unlink ${l.name}` });
      // Discount days folded in: what they sold, at what price, and the cost as a share of it.
      const regular = l.includes?.length ? { quantity: l.sold - l.includes.reduce((a, v) => a + v.quantity, 0), netSales: l.netSales - l.includes.reduce((a, v) => a + v.netSales, 0) } : null;
      const line = (label, q, sales) => h('div', { class: 'small muted', text: `${label}: ${Math.round(q).toLocaleString()} sold${q > 0 ? ` at ${money2(sales / q)}` : ''}${q > 0 && r.cost ? ` · cost ${Math.round((r.cost / (sales / q)) * 100)}%` : ''}` });
      const row = h('div', {}, h('span', { class: 'grow' }, h('div', { text: l.name }),
        regular ? [line('Regular price', regular.quantity, regular.netSales), l.includes.map((v) => line(v.variationName || v.name, v.quantity, v.netSales))]
          : h('div', { class: 'small muted', text: `${Math.round(l.sold).toLocaleString()} sold lately` })), btn);
      btn.addEventListener('click', async () => {
        if (!confirmText(`Unlink ${l.name} from ${r.name}? It goes back to “selling without a recipe” until it has one.`)) return;
        busy(btn, true);
        const res = await api('POST', '/api/cards/unlink', { items: [{ catalogId: l.catalogId, itemName: l.itemName, ...(l.variationName ? { variationName: l.variationName } : {}) }] });
        if (!res.ok) { busy(btn, false); return row.append(h('div', { class: 'error small', text: res.data.error ?? 'Not unlinked.' })); }
        reload?.();
      });
      return row;
    })));
}

// ------------------------------------------------------------------ recipe cards

const KIND_NAMES = { dish: 'Dish', drink: 'Drink', prep: 'Prep', barPrep: 'Bar prep' };
const UNIT_LABEL = (u) => ({ floz: 'fl oz', each: 'each' }[u] ?? u);
const money2 = (v) => (v === undefined || v === null ? '–' : `$${Number(v).toFixed(2)}`);

async function cardsScreen(me, opts = {}) {
  loadingScreen(me, 'menu', 'Recipe costs');
  const side = sideOf(me);
  const r = await api('GET', `/api/cards?area=${side}`);
  if (!r.ok) return show(shell(me, 'menu', [h('h1', { text: 'Recipe costs' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const d = r.data;
  const filter = opts.filter ?? '';
  const cardRows = d.cards.filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase())).map((c) => {
    const share = c.cost !== undefined && c.averagePrice ? c.cost / c.averagePrice : undefined;
    return h('div', { class: 'crow' },
      h('div', {}, h('button', { class: 'linkish name', text: c.name, onclick: () => cardEditor(me, d, c) }),
        h('div', { class: 'small muted', text: [c.linked.length ? `sells as ${c.linked.slice(0, 2).map((l) => l.name).join(', ')}${c.linked.length > 2 ? ` +${c.linked.length - 2}` : ''}` : c.usedBy.length ? `used in ${c.usedBy.slice(0, 2).join(', ')}${c.usedBy.length > 2 ? ` +${c.usedBy.length - 2}` : ''}` : c.kind === 'dish' || c.kind === 'drink' ? 'not linked to a button' : ''].filter(Boolean).join('') })),
      h('span', { class: `tag${c.kind === 'drink' || c.kind === 'barPrep' ? ' blue' : ''}`, text: KIND_NAMES[c.kind] }),
      h('div', { class: 'num', text: c.cost !== undefined ? `${money2(c.cost)}${c.complete ? '' : '*'}` : '–' }),
      h('div', { class: 'num small muted', text: share !== undefined ? `${pct(share)} of ${money2(c.averagePrice)}` : c.kind.endsWith('rep') ? `per ${c.yields[0] ? `${qty(c.yields[0].amount)} ${UNIT_LABEL(c.yields[0].unit)}` : 'batch'}` : '' }),
      c.problems?.length ? h('span', { class: 'tag warn', title: c.problems.join('\n'), text: `${c.problems.length} to fix` }) : h('span'));
  });
  const search = h('input', { type: 'text', placeholder: 'Find a recipe', 'aria-label': 'Find a recipe', value: filter });
  search.addEventListener('change', () => cardsScreen(me, { filter: search.value }));
  // Down the side: what still sells without a card (the full list is on Recipe coverage), names to tidy, a new card.
  const noCardBox = d.noCard.length ? sideBox(`Selling without a recipe (${d.noCard.length})`,
    h('div', { class: 'list compact' }, d.noCard.slice(0, 8).map((x) => h('div', {},
      h('button', { class: 'linkish grow', text: x.name, title: `Write the recipe for ${x.name}`, onclick: () => cardEditor(me, d, null, { name: x.itemName, kind: side === 'bar' ? 'drink' : 'dish', link: [x] }) }),
      h('span', { class: 'small muted', text: dollars(x.netSales) })))),
    sideActions(h('button', { class: 'btn small-btn', text: 'All of them', onclick: () => coverageScreen(me) }),
      side === 'bar' ? h('button', { class: 'btn small-btn dark', text: 'Draft bar recipes', onclick: () => draftsScreen(me) }) : null)) : null;
  const tidy = (await api('GET', '/api/cards/tidy')).data?.proposals ?? [];
  const tidyCount = tidy.filter((t) => t.to || t.remove).length;
  const tidyBox = tidyCount ? sideBox('Names to tidy', h('div', { class: 'small muted', text: `${tidyCount} recipe name${tidyCount === 1 ? '' : 's'} could match Square, be capitalized, or lose a duplicate.` }),
    sideActions(h('button', { class: 'btn small-btn', text: 'Review names', onclick: () => tidyScreen(me) }))) : null;
  const kinds = Object.entries(KIND_NAMES).map(([k, t]) => [t, d.cards.filter((c) => c.kind === k).length]).filter(([, n]) => n);
  const fix = d.cards.filter((c) => c.problems?.length).length;
  const totals = sideBox('Recipes', h('div', { class: 'list compact' }, kinds.map(([t, n]) => h('div', {}, h('span', { class: 'grow', text: t }), h('b', { text: String(n) })))),
    fix ? h('div', { class: 'small warn-text', text: `${fix} with something to fix: hover the tag for what.` }) : null,
    sideActions(h('button', { class: 'btn small-btn dark', text: 'New recipe', onclick: () => cardEditor(me, d, null, { kind: side === 'bar' ? 'drink' : 'dish' }) })));
  show(shell(me, 'menu', [
    h('header', { class: 'row wrap' },
      h('div', { class: 'grow' }, h('div', { class: 'kicker', text: `${AREA_NAMES[side]} · costed from invoice prices` }), h('h1', { text: 'Recipe costs' }),
        h('div', { class: 'sub', text: side === 'bar' ? 'Every drink poured or mixed has a recipe: a pour from the bottle or keg, a cocktail spec, a dose of coffee. Cans and sodas are one of what was bought.' : 'What goes into each dish and prep, priced from what you paid.' })),
      h('div', { class: 'row wrap' }, h('button', { class: 'btn', text: '← Menu', onclick: () => menuScreen(me) }), sideSwitch(me, () => cardsScreen(me)))),
    page(h('section', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { class: 'grow', text: `Recipes (${d.cards.length})` }), search),
      cardRows.length ? h('div', { class: 'clist' }, h('div', { class: 'crow head' }, h('div', { text: 'Recipe' }), h('div', { text: 'Kind' }), h('div', { class: 'num', text: 'Cost' }), h('div', { class: 'num', text: 'Of the price' }), h('div')), cardRows)
        : h('div', { class: 'small muted', text: side === 'bar' ? 'No drink recipes yet.' : 'No recipes yet.' }),
      h('div', { class: 'small muted', text: '* part of the recipe has no price yet.' })),
    [totals, noCardBox, tidyBox]),
  ]));
}

/** Card names to tidy, reviewed before anything changes. */
async function tidyScreen(me) {
  loadingScreen(me, 'menu', 'Tidy recipe names');
  const r = await api('GET', '/api/cards/tidy');
  const list = r.data.proposals ?? [];
  const err = h('div', { class: 'error' });
  const rows = list.map((t) => {
    const can = Boolean(t.to || t.remove);
    t.on = can;
    const box = h('input', { type: 'checkbox', checked: can ? true : undefined, disabled: can ? undefined : true, 'aria-label': `${t.remove ? 'Remove' : 'Rename'} ${t.from}` });
    box.addEventListener('change', () => { t.on = box.checked; });
    const to = t.to ? h('input', { type: 'text', value: t.to, 'aria-label': `New name for ${t.from}` }) : null;
    to?.addEventListener('change', () => { t.to = to.value; });
    return h('div', { class: `trow${can ? '' : ' off'}` }, box,
      h('div', { class: 'strike', text: t.from }),
      t.remove ? h('span', { class: 'tag bad', text: 'Remove duplicate' }) : to ?? h('span', { class: 'small muted', text: 'unchanged' }),
      h('div', { class: 'small muted', text: t.why }));
  });
  const apply = h('button', { class: 'btn dark', text: 'Apply checked', onclick: async () => {
    const on = list.filter((t) => t.on);
    if (!on.length) return (err.textContent = 'Nothing checked.');
    apply.disabled = true;
    const res = await api('POST', '/api/cards/tidy', { renames: on.filter((t) => t.to).map((t) => ({ index: t.index, from: t.from, to: t.to })), removes: on.filter((t) => t.remove).map((t) => ({ index: t.index, from: t.from })) });
    apply.disabled = false;
    if (!res.ok) return (err.textContent = res.data.error ?? 'Not saved.');
    cardsScreen(me);
  } });
  show(shell(me, 'menu', [
    h('header', { class: 'row wrap' },
      h('div', { class: 'grow' }, h('div', { class: 'kicker', text: 'Recipe costs' }), h('h1', { text: 'Tidy recipe names' }),
        h('div', { class: 'sub', text: 'Dishes and drinks take the name they sell under in Square; everything else is capitalized. Every rename follows the recipe into the recipes that use it, the prep lists and menu plans.' })),
      h('button', { class: 'btn', text: '← Recipe costs', onclick: () => cardsScreen(me) })),
    page(h('section', { class: 'card' }, list.length ? h('div', { class: 'tlist' }, rows) : h('div', { class: 'small muted', text: 'Every name is tidy.' })),
      list.length ? [sideBox('Apply', h('div', { class: 'small', text: `${list.filter((t) => t.to).length} to rename · ${list.filter((t) => t.remove).length} duplicate${list.filter((t) => t.remove).length === 1 ? '' : 's'} to remove` }),
        h('div', { class: 'small muted', text: 'Uncheck anything that should stay as it is.' }), err, sideActions(apply))] : null),
  ]));
}

/** Write or change one card: what goes in, how much, what it makes, which buttons sell it. */
function cardEditor(me, d, card, start = {}) {
  // Where it was opened from is where Back, Cancel and Save return to (Recipe costs unless said).
  const back = start.back ?? { label: 'Recipe costs', go: () => cardsScreen(me), rail: 'menu' };
  const c = card ? JSON.parse(JSON.stringify(card)) : { name: start.name ?? '', kind: start.kind ?? 'dish', yields: [{ amount: 1, unit: 'qt' }], ingredients: [], linked: start.link ?? [] };
  if (!c.ingredients.length) c.ingredients.push({ amount: '', unit: '', name: '' });
  const options = [...d.products.map((p) => ({ name: p.name, units: p.units, unit: p.unit, price: p.price, kind: 'product' })), ...d.allCards.filter((x) => x.name !== card?.name).map((x) => ({ name: x.name, units: x.units, unit: x.unit, kind: 'card' }))];
  const byName = new Map(options.map((o) => [o.name.toLowerCase(), o]));
  const listId = 'ingredient-options';
  const datalist = h('datalist', { id: listId }, options.map((o) => h('option', { value: o.name, label: o.kind === 'card' ? 'recipe' : UNIT_LABEL(o.unit) })));
  const err = h('div', { class: 'error', role: 'alert' });
  const total = h('div', { class: 'big' });
  const totalNote = h('div', { class: 'small muted' });
  const lines = h('div', { class: 'ilist' });
  let previewTimer;
  const preview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const res = await api('POST', '/api/cards/preview', { card: { ingredients: c.ingredients.filter((i) => i.name) } });
      if (!res.ok) return;
      const filled = c.ingredients.filter((i) => i.name);
      [...lines.querySelectorAll('.icost')].forEach((el, n) => {
        const l = res.data.lines[filled.indexOf(c.ingredients[n])] ?? {};
        el.textContent = l.cost !== undefined ? money2(l.cost) : '';
        el.title = l.problem ?? '';
        el.classList.toggle('warn-text', Boolean(l.problem));
      });
      total.textContent = money2(res.data.total);
      const per = c.kind === 'prep' || c.kind === 'barPrep' ? `for ${qty(Number(c.yields[0]?.amount) || 0)} ${UNIT_LABEL(c.yields[0]?.unit ?? '')}` : `a ${c.kind === 'drink' ? 'drink' : 'plate'}`;
      const price = card?.averagePrice;
      totalNote.textContent = `${per}${price && c.kind !== 'prep' && c.kind !== 'barPrep' ? ` · ${pct(res.data.total / price)} of the ${money2(price)} it sells for` : ''}${res.data.complete ? '' : ' · some lines can’t be priced yet'}`;
    }, 250);
  };
  const unitSelect = (i) => {
    const o = byName.get(String(i.name).toLowerCase());
    let units = o?.units ?? ['each', 'g', 'oz', 'lb', 'ml', 'floz', 'qt'];
    // A unit the card already uses stays, even when it can't be converted yet (the cost line says so).
    if (i.unit && !units.includes(i.unit)) units = [i.unit, ...units];
    if (!i.unit) i.unit = o ? (o.kind === 'product' && ['bottle', 'keg', 'gal', 'l'].includes(o.unit) && units.includes('floz') ? 'floz' : o.unit) : units[0];
    const sel = h('select', { 'aria-label': `Unit for ${i.name || 'ingredient'}` }, units.map((u) => h('option', { value: u, text: UNIT_LABEL(u) + (o && !o.units.includes(u) ? ' (no conversion yet)' : ''), selected: u === i.unit ? true : undefined })));
    sel.addEventListener('change', () => { i.unit = sel.value; preview(); });
    return sel;
  };
  const drawLines = () => {
    fill(lines, h('div', { class: 'irow head' }, h('div', { text: 'Amount' }), h('div', { text: 'Unit' }), h('div', { text: 'What goes in' }), h('div', { class: 'num', text: 'Cost' }), h('div')),
      c.ingredients.map((i, n) => {
        const amount = h('input', { inputmode: 'decimal', value: i.amount === '' ? '' : String(i.amount), 'aria-label': 'Amount', placeholder: '0' });
        amount.addEventListener('change', () => { i.amount = Number(amount.value) || ''; preview(); });
        const name = h('input', { type: 'text', list: listId, value: i.name, 'aria-label': 'Ingredient', placeholder: 'Start typing a product or recipe' });
        const unitSlot = h('div', {}, unitSelect(i));
        name.addEventListener('change', () => { i.name = name.value.trim(); const o = byName.get(i.name.toLowerCase()); if (o) i.name = o.name; if (!o || !o.units.includes(i.unit)) i.unit = ''; fill(unitSlot, unitSelect(i)); preview(); });
        return h('div', { class: 'irow' }, amount, unitSlot, name, h('div', { class: 'num icost small' }),
          h('button', { class: 'btn small-btn', 'aria-label': `Remove ${i.name || 'line'}`, text: '×', onclick: () => { c.ingredients.splice(n, 1); drawLines(); preview(); } }));
      }),
      h('button', { class: 'btn small-btn', text: '+ Add a line', onclick: () => { c.ingredients.push({ amount: '', unit: '', name: '' }); drawLines(); lines.querySelector('.irow:last-of-type input[list]')?.focus(); } }));
  };
  const nameInput = h('input', { type: 'text', value: c.name, 'aria-label': 'Recipe name', placeholder: 'e.g. Negroni' });
  nameInput.addEventListener('change', () => { c.name = nameInput.value; });
  const kind = h('select', { 'aria-label': 'Kind' }, Object.entries(KIND_NAMES).map(([k, t]) => h('option', { value: k, text: t, selected: k === c.kind ? true : undefined })));
  const yieldBox = h('div', { class: 'row wrap' });
  const drawYield = () => {
    if (c.kind !== 'prep' && c.kind !== 'barPrep') return fill(yieldBox);
    const y = c.yields[0] ?? (c.yields[0] = { amount: 1, unit: 'qt' });
    const amt = h('input', { inputmode: 'decimal', value: String(y.amount), 'aria-label': 'A batch makes', class: 'short' });
    amt.addEventListener('change', () => { y.amount = Number(amt.value) || 0; preview(); });
    const unit = h('select', { 'aria-label': 'Batch unit', class: 'fit' }, ['qt', 'pt', 'gal', 'floz', 'ml', 'l', 'cup', 'oz', 'lb', 'g', 'kg', 'each', 'bottle', 'portion', 'batch'].map((u) => h('option', { value: u, text: UNIT_LABEL(u), selected: u === y.unit ? true : undefined })));
    unit.addEventListener('change', () => { y.unit = unit.value; preview(); });
    fill(yieldBox, h('span', { class: 'small strong', text: 'A batch makes' }), amt, unit);
  };
  kind.addEventListener('change', () => { c.kind = kind.value; drawYield(); preview(); });
  const method = h('textarea', { 'aria-label': 'Method', rows: '3', placeholder: 'How it’s made (optional): build in a rocks glass over ice, stir, orange peel…' });
  method.value = c.method ?? '';
  method.addEventListener('change', () => { c.method = method.value; });

  // Buttons that sell it.
  const linkBox = h('div');
  const unlinked = [];
  const drawLinks = () => {
    const pick = h('select', { 'aria-label': 'Link a button' }, h('option', { value: '', text: 'Link a button that sells it…' }),
      d.noCard.filter((x) => !c.linked.some((l) => l.catalogId === x.catalogId && l.name === x.name)).map((x, n) => h('option', { value: String(n), text: `${x.name} · ${x.sold} sold` })));
    const pool = d.noCard.filter((x) => !c.linked.some((l) => l.catalogId === x.catalogId && l.name === x.name));
    pick.addEventListener('change', () => { if (pick.value) { c.linked.push(pool[Number(pick.value)]); drawLinks(); } });
    fill(linkBox,
      c.linked.length ? h('div', { class: 'list' }, c.linked.map((l, n) => h('div', {}, h('span', { class: 'grow', text: l.name }), l.sold !== undefined ? h('span', { class: 'small muted', text: `${l.sold} sold` }) : null,
        h('button', { class: 'link', text: 'Unlink', onclick: () => { unlinked.push(...c.linked.splice(n, 1)); drawLinks(); } })))) : h('div', { class: 'small muted', text: 'Not linked to a POS button yet.' }),
      c.kind === 'dish' || c.kind === 'drink' ? pick : null);
  };

  const save = async () => {
    err.textContent = '';
    const body = { card: { name: nameInput.value, kind: c.kind, yields: c.yields, ingredients: c.ingredients.filter((i) => i.name || i.amount), method: method.value }, ...(card ? { previousName: card.name } : {}),
      link: c.linked.filter((l) => !(card?.linked ?? []).some((x) => x.catalogId === l.catalogId && x.name === l.name)), unlink: unlinked };
    const res = await api('POST', '/api/cards', body);
    if (!res.ok) return (err.textContent = res.data.error ?? 'Not saved.');
    back.go(nameInput.value.trim());
  };
  const del = card && !card.usedBy?.length ? h('button', { class: 'link danger', text: 'Delete recipe', onclick: async () => {
    if (!confirmText(`Delete the ${card.name} recipe? Buttons linked to it go back to “selling without a recipe”.`)) return;
    const res = await api('POST', '/api/cards/delete', { name: card.name });
    if (!res.ok) return (err.textContent = res.data.error ?? 'Not deleted.');
    if (back.rail === 'recipes') recipesScreen(me); else cardsScreen(me);
  } }) : null;

  drawLines(); drawYield(); drawLinks(); preview();
  show(shell(me, back.rail, [
    h('header', { class: 'row wrap' },
      h('div', { class: 'grow' }, h('div', { class: 'kicker', text: card ? 'Recipe' : 'New recipe' }), h('h1', { text: card?.name ?? (c.name || 'New recipe') })),
      h('button', { class: 'btn', text: `← ${back.label}`, onclick: () => back.go() })),
    h('div', { class: 'page editor' },
      h('section', { class: 'card page-main' },
        h('div', { class: 'row wrap' }, h('label', { class: 'grow' }, 'Name', nameInput), h('label', {}, 'Kind', kind)),
        yieldBox,
        datalist, lines,
        h('label', {}, 'Method', method),
        err,
        h('div', { class: 'row wrap' }, h('button', { class: 'btn dark', text: 'Save recipe', onclick: save }), h('button', { class: 'btn', text: 'Cancel', onclick: () => back.go() }), h('div', { class: 'grow' }), del)),
      h('aside', { class: 'page-side' },
        h('div', { class: 'card tight' }, h('div', { class: 'small muted strong', text: 'Cost' }), total, totalNote),
        h('div', { class: 'card tight' }, h('div', { class: 'small muted strong', text: 'Sells as' }), linkBox),
        card?.usedBy?.length ? h('div', { class: 'card tight' }, h('div', { class: 'small muted strong', text: 'Used in' }), h('div', { class: 'small', text: card.usedBy.join(' · ') })) : null)),
  ]));
  if (!card) nameInput.focus();
}

const SHAPES = [
  ['wineGlass', 'Wine by the glass', 'A pour from the bottle.'],
  ['wineBottle', 'Wine by the bottle', 'One bottle.'],
  ['draft', 'Draft beer', 'A pour from the keg on tap.'],
  ['direct', 'Cans, bottles and sodas', 'Sold as bought: one of what’s on the invoice.'],
  ['coffee', 'Coffee', 'A dose of beans; milk for milk drinks.'],
];

/** The bar, drafted from POS buttons and invoices: a group at a time. */
async function draftsScreen(me, pours = {}) {
  pours = { winePour: 6, draftPour: 16, dose: 18, ...pours };
  loadingScreen(me, 'menu', 'Draft bar recipes');
  const r = await api('GET', `/api/cards/drafts?winePour=${pours.winePour}&draftPour=${pours.draftPour}&dose=${pours.dose}`);
  if (!r.ok) return show(shell(me, 'menu', [h('h1', { text: 'Draft bar recipes' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const { drafts, products } = r.data;
  const pourInput = (key, label, unit) => {
    const input = h('input', { inputmode: 'decimal', value: String(pours[key]), class: 'short', 'aria-label': label });
    input.addEventListener('change', () => { const v = Number(input.value); if (v > 0) draftsScreen(me, { ...pours, [key]: v }); });
    return h('label', { class: 'inline' }, label, h('span', { class: 'row tight' }, input, h('span', { class: 'small muted', text: unit })));
  };
  const groups = SHAPES.map(([shape, title, note]) => {
    const list = drafts.filter((x) => x.shape === shape);
    if (!list.length) return null;
    const pool = products.filter((p) => shape.startsWith('wine') ? p.type === 'WINE' : shape === 'draft' ? p.unit === 'keg' : shape === 'direct' ? ['can', 'bottle', 'each'].includes(p.unit) && p.type !== 'WINE' && p.type !== 'LIQUOR' : true);
    const rows = list.map((dr) => {
      dr.include = dr.include ?? (Boolean(dr.ingredients.length) && !dr.cardExists);
      const ing = dr.ingredients[0];
      const box = h('input', { type: 'checkbox', checked: dr.include ? true : undefined, 'aria-label': `Save ${dr.name}` });
      box.addEventListener('change', () => { dr.include = box.checked; });
      const pick = h('select', { 'aria-label': `Product for ${dr.name}` },
        h('option', { value: '', text: dr.matches.length ? 'Pick another…' : 'Pick the product…' }),
        dr.matches.map((m) => h('option', { value: m.name, text: m.name, selected: ing?.name === m.name ? true : undefined })),
        h('optgroup', { label: 'All' }, pool.filter((p) => !dr.matches.some((m) => m.name === p.name)).map((p) => h('option', { value: p.name, text: p.name }))));
      pick.addEventListener('change', () => {
        if (!pick.value) return;
        const p = products.find((x) => x.name === pick.value);
        if (dr.ingredients[0]) dr.ingredients[0].name = pick.value;
        else dr.ingredients = [{ amount: shape === 'wineGlass' ? pours.winePour : shape === 'draft' ? pours.draftPour : 1, unit: shape === 'wineGlass' || shape === 'draft' ? 'floz' : p?.unit ?? 'each', name: pick.value }];
        if (shape === 'direct' || shape === 'wineBottle') dr.ingredients[0].unit = p?.unit ?? dr.ingredients[0].unit;
        dr.include = true; box.checked = true;
      });
      const amount = shape === 'wineGlass' || shape === 'draft' ? h('span', { class: 'small muted', text: `${qty(ing?.amount ?? (shape === 'draft' ? pours.draftPour : pours.winePour))} fl oz` })
        : shape === 'coffee' ? h('span', { class: 'small muted', text: dr.ingredients.map((i) => `${qty(i.amount)} ${UNIT_LABEL(i.unit)} ${i.name}`).join(' + ') }) : h('span', { class: 'small muted', text: `1 ${ing?.unit ?? ''}` });
      return h('div', { class: `drow${dr.check ? ' flagged' : ''}` }, box,
        h('div', {}, h('div', { class: 'strong', text: dr.name }), h('div', { class: 'small muted', text: `${dr.quantity} sold · ${dollars(dr.netSales)}${dr.items.length > 1 ? ` · ${dr.items.length} buttons` : ''}${dr.cardExists ? ' · a recipe with this name exists' : ''}` })),
        shape === 'coffee' ? amount : h('div', { class: 'row tight' }, pick, amount),
        dr.check ? h('span', { class: 'tag warn', text: dr.matches.length ? 'Check' : 'Pick' }) : h('span'));
    });
    const err = h('div', { class: 'error' });
    const saveBtn = h('button', { class: 'btn dark', text: `Save checked ${title.toLowerCase()}`, onclick: async () => {
      const chosen = list.filter((x) => x.include && x.ingredients.length);
      if (!chosen.length) return (err.textContent = 'Nothing checked.');
      saveBtn.disabled = true;
      const res = await api('POST', '/api/cards/batch', { cards: chosen.map((x) => ({ card: { name: x.name, kind: 'drink', ingredients: x.ingredients }, link: x.items })) });
      saveBtn.disabled = false;
      if (!res.ok) return (err.textContent = res.data.error ?? 'Not saved.');
      draftsScreen(me, pours);
    } });
    return h('section', { class: 'card', id: `group-${shape}` },
      h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, h('h2', { text: `${title} (${list.length})` }), h('div', { class: 'small muted', text: note })),
        shape === 'wineGlass' ? pourInput('winePour', 'Pour', 'fl oz') : shape === 'draft' ? pourInput('draftPour', 'Pour', 'fl oz') : shape === 'coffee' ? pourInput('dose', 'Dose', 'g') : null),
      h('div', { class: 'dlist' }, rows), err, h('div', {}, saveBtn));
  });
  const own = drafts.filter((x) => x.shape === 'ownCard');
  const ownBox = own.length ? h('section', { class: 'card', id: 'group-ownCard' },
    h('h2', { text: `Cocktails and house drinks (${own.length})` }),
    h('div', { class: 'small muted', text: 'Each gets its own recipe: the spec, the syrups and juices from bar prep, the garnish. Fees and things nothing is poured for need no recipe.' }),
    h('div', { class: 'list' }, own.map((x) => h('div', {},
      h('div', { class: 'grow' }, h('div', { text: x.name }), h('div', { class: 'small muted', text: `${x.category} · ${x.quantity} sold · ${dollars(x.netSales)}` })),
      h('button', { class: 'btn small-btn', text: 'Write recipe', onclick: async () => {
        const d = (await api('GET', '/api/cards?area=bar')).data;
        cardEditor(me, d, null, { name: x.name, kind: 'drink', link: x.items.map((i) => ({ ...i, name: i.variationName ? `${i.itemName} (${i.variationName})` : i.itemName })) });
      } }),
      h('button', { class: 'link', text: 'No recipe needed', onclick: async () => { await api('POST', '/api/cards/no-card', { items: x.items }); draftsScreen(me, pours); } }))))) : null;
  show(shell(me, 'menu', [
    h('header', { class: 'row wrap' },
      h('div', { class: 'grow' }, h('div', { class: 'kicker', text: 'Bar · from Square buttons and MarginEdge products' }), h('h1', { text: 'Draft bar recipes' }),
        h('div', { class: 'sub', text: 'Each drink matched to the bottle, keg or can it comes from. Check what’s flagged, uncheck anything wrong, and save a group at a time. Saved recipes can be changed like any other.' })),
      h('button', { class: 'btn', text: '← Recipe costs', onclick: () => cardsScreen(me) })),
    page([groups, ownBox, drafts.length ? null : h('div', { class: 'card small muted', text: 'Every drink has a recipe.' })], drafts.length ? [
      sideBox('Groups', h('div', { class: 'picks' }, [...SHAPES.map(([shape, title]) => [shape, title]), ['ownCard', 'Cocktails and house drinks']].map(([shape, title]) => {
        const list = drafts.filter((x) => x.shape === shape);
        if (!list.length) return null;
        const flagged = list.filter((x) => x.check).length;
        return h('button', { class: 'pick', onclick: () => document.getElementById(`group-${shape}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
          h('span', { class: 'grow', text: title }), flagged ? h('span', { class: 'tag warn', text: `${flagged} to check` }) : null, h('span', { class: 'small muted', text: String(list.length) }));
      }))),
      sideBox('Pours', h('div', { class: 'list compact' },
        h('div', {}, h('span', { class: 'grow', text: 'Wine by the glass' }), h('b', { text: `${qty(pours.winePour)} fl oz` })),
        h('div', {}, h('span', { class: 'grow', text: 'Draft beer' }), h('b', { text: `${qty(pours.draftPour)} fl oz` })),
        h('div', {}, h('span', { class: 'grow', text: 'Coffee dose' }), h('b', { text: `${qty(pours.dose)} g` }))),
        h('div', { class: 'small muted', text: 'Change a pour at the top of its group; every draft in it follows.' })),
    ] : null),
  ]));
}

// ------------------------------------------------------------------ today

const TODAY_FILTERS = [['all', 'All'], ['prep', 'Prep'], ['orders', 'Orders'], ['menu', 'Menu'], ['costs', 'Costs']];
const TONE_CLASS = { due: 'due', ask: 'ask', alert: 'alert', info: 'info' };
const longDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const weekdayName = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' });

let todaySeq = 0;
async function todayScreen(me, filter = 'all') {
  const seq = ++todaySeq;
  loadingScreen(me, 'today', 'Today');
  const r = await api('GET', '/api/today');
  if (!r.ok) return show(shell(me, 'today', [h('h1', { text: 'Today' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  let t = r.data;
  // Lines just answered or snoozed stay where they were, folded up with an Undo, until you leave Today.
  const done = new Map();
  const here = () => seq === todaySeq && app.querySelector('.shell[data-active="today"]');
  // Fetches again quietly and redraws: the page never goes blank for it.
  const refresh = () => refreshInPlace(async () => {
    const again = await api('GET', '/api/today');
    if (again.ok && here()) { t = again.data; inPlace = true; draw(); }
  });
  const go = (g) => ({
    count: () => prepCount(me, g.stationId, g.date), review: () => prepReview(me, g.stationId, g.date), work: () => prepWork(me, g.stationId, g.date),
    menu: () => menuScreen(me), performance: () => marginsScreen(me), settings: () => home(me),
    cards: () => cardsScreen(me), drafts: () => draftsScreen(me), order: () => orderScreen(me, g.vendorId), orders: () => { if (g.side) me.side = g.side; ordersScreen(me); },
  })[g.to]?.();
  const targetOf = (b) => (b.type === 'dismiss' ? { dedupeKey: b.dedupeKey } : { catalogId: b.catalogId, itemName: b.itemName, ...(b.variationName ? { variationName: b.variationName } : {}), ...(b.from ? { from: b.from } : {}) });
  // A line folded up in place: what was done, and Undo. Saving happens behind it.
  const foldUp = (row, i, said, undo) => {
    const index = [...row.parentNode.children].indexOf(row);
    const indexIn = [...row.parentNode.children].filter((x) => x.matches('.todo')).indexOf(row);
    done.set(i.key, { item: i, said, undo, index, indexIn });
    row.replaceWith(doneRow(i.key));
  };
  const doneRow = (key) => {
    const d = done.get(key);
    const undoBtn = h('button', { class: 'link', text: 'Undo' });
    const row = h('article', { class: 'todo done-row', role: 'status' },
      h('div', { class: 'todo-label', text: 'Done' }),
      h('div', { class: 'todo-body' }, h('div', { class: 'todo-title', text: d.item.title }), h('div', { class: 'small muted', text: d.said })),
      h('div', { class: 'todo-actions' }, d.failed ? h('span', { class: 'error small', text: d.failed }) : undoBtn));
    undoBtn.addEventListener('click', async () => {
      busy(undoBtn, true);
      const res = await d.undo();
      if (!res.ok) { busy(undoBtn, false); return row.append(h('div', { class: 'error small', text: res.data.error ?? 'Couldn’t undo it.' })); }
      done.delete(key);
      refresh();
    });
    return row;
  };
  const answer = (row, i, a) => pageAction(async () => {
    foldUp(row, i, `Answered: ${a.label}`, () => api('POST', '/api/answers/undo', { target: targetOf(a.body) }));
    const res = await api('POST', '/api/answers', a.body);
    if (!res.ok) { done.delete(i.key); if (here()) draw(); return showError(res.data.error ?? 'That didn’t save.', i.key); }
    refresh();
  });
  // Snoozing: set a line aside for a while (just for you), or bring it back.
  const snooze = async (keys, choice, row) => {
    row?.querySelectorAll('button').forEach((b) => (b.disabled = true));
    const res = await api('POST', '/api/today/snooze', { keys, ...(choice.hours ? { hours: choice.hours } : choice.day ? { day: choice.day } : { wake: true }) });
    if (!res.ok) {
      row?.querySelectorAll('button').forEach((b) => (b.disabled = false));
      return row?.append(h('div', { class: 'error', text: res.data.error ?? 'That didn’t save.' }));
    }
    refresh();
  };
  const snoozeOne = (row, i, c) => pageAction(async () => {
    foldUp(row, i, `Snoozed ${c.label.toLowerCase()}`, () => api('POST', '/api/today/snooze', { keys: [i.key], wake: true }));
    const res = await api('POST', '/api/today/snooze', { keys: [i.key], ...(c.hours ? { hours: c.hours } : { day: c.day }) });
    if (!res.ok) { done.delete(i.key); if (here()) draw(); return showError(res.data.error ?? 'That didn’t save.', i.key); }
    refresh();
  });
  let errorFor = null;
  const showError = (text, key) => { errorFor = { text, key }; if (here()) draw(); };
  const itemRow = (i) => {
    const row = h('article', { class: `todo ${TONE_CLASS[i.tone] ?? ''}${i.answers?.length ? ' has-answers' : ''}` });
    const actions = h('div', { class: 'todo-actions' });
    const normal = () => { row.classList.remove('choosing'); fillNormal(); };
    const fillNormal = () => fill(actions,
      (i.answers ?? []).map((a, n) => h('button', { class: `btn small-btn${n === 0 ? ' blue' : ''}`, text: a.label, onclick: () => answer(row, i, a) })),
      i.answers?.length ? h('button', { class: 'link', text: `More on ${i.go.to === 'menu' ? 'Menu' : 'its screen'}`, onclick: () => go(i.go) })
        : h('button', { class: 'btn small-btn dark', text: i.button, onclick: () => go(i.go) }),
      i.snooze?.length ? h('button', { class: 'link snooze-link', text: 'Snooze', title: 'Set it aside for a while, just for you', onclick: choose }) : null);
    // The choices replace the buttons in place: no pop-ups over the list.
    function choose() {
      row.classList.add('choosing');
      fill(actions, h('span', { class: 'small muted', text: 'Snooze:' }),
        i.snooze.map((c) => h('button', { class: 'btn small-btn', text: c.label, onclick: () => snoozeOne(row, i, c) })),
        h('button', { class: 'link', text: 'Cancel', onclick: normal }));
      actions.querySelector('.btn')?.focus();
    }
    normal();
    const tab = TODO_TABS[todoTab(i)];
    row.style.setProperty('--tab', tab.color);
    fill(row,
      h('div', { class: 'todo-label' }, h('span', { class: 'tab-tag', text: tab.name }), i.label.toLowerCase() === tab.name.toLowerCase() ? null : h('span', { text: i.label })),
      h('div', { class: 'todo-body' }, h('div', { class: 'todo-title', text: i.title }), i.detail ? h('div', { class: 'small muted', text: i.detail }) : null,
        errorFor?.key === i.key ? h('div', { class: 'error small', text: errorFor.text }) : null),
      actions);
    return row;
  };
  const snoozedRow = (i) => h('div', { class: 'snoozed-row' },
    h('div', { class: 'grow' }, h('div', { class: 'strong', text: i.title }), h('div', { class: 'small muted', text: `${i.label} · back ${when(i.snoozedUntil)}` })),
    h('button', { class: 'btn small-btn', text: 'Bring back', onclick: (e) => snooze([i.key], {}, e.target.closest('.snoozed-row')) }));

  function draw() {
    // Kitchen, bar or both: where this person works, until they switch.
    // (On a station's iPad, that station is the side.)
    const side = me.device?.stationId && !t.glance ? 'all' : me.todaySide ?? t.side ?? 'all';
    const sideItems = t.items.filter((i) => !done.has(i.key) && (side === 'all' || !i.side || i.side === side));
    const onSide = sideItems.filter((i) => !i.snoozedUntil);
    const asleep = sideItems.filter((i) => i.snoozedUntil).sort((a, b) => a.snoozedUntil.localeCompare(b.snoozedUntil));
    const shown = onSide.filter((i) => filter === 'all' || i.group === filter || (filter === 'costs' && i.group === 'setup'));
    // Everything showing that has no deadline can be set aside until tomorrow in one go.
    const canWait = shown.filter((i) => !i.due && i.snooze?.some((c) => c.day));
    const tomorrow = canWait[0]?.snooze.find((c) => c.day && c.label === 'Until tomorrow');
    const quiet = canWait.length >= 3 && tomorrow ? sideBox('Too much at once?',
      h('div', { class: 'small', text: `${canWait.length} of these have no deadline. Snooze them until tomorrow morning; deadlines stay.` }),
      sideActions(h('button', { class: 'btn small-btn dark', text: `Snooze ${canWait.length} until tomorrow`, onclick: (e) => snooze(canWait.map((i) => i.key), tomorrow, e.target.closest('section')) })),
      h('div', { class: 'small muted', text: 'Just for you: the rest of the team still sees them.' })) : null;
    const asleepBox = asleep.length ? h('details', { class: 'card snoozed' },
      h('summary', {}, h('span', { class: 'strong', text: `${asleep.length} snoozed` }), h('span', { class: 'small muted', text: ` · first back ${when(asleep[0].snoozedUntil)}` })),
      h('div', { class: 'list' }, asleep.map(snoozedRow)),
      asleep.length > 1 ? h('div', {}, h('button', { class: 'link', text: 'Bring them all back', onclick: (e) => snooze(asleep.map((i) => i.key), {}, e.target.closest('details')) })) : null) : null;
    const groups = new Set(onSide.map((i) => (i.group === 'setup' ? 'costs' : i.group)));
    // Switching side or filter only redraws what's already here: no trip to the server.
    const sides = t.glance ? h('div', { class: 'seg', role: 'group', 'aria-label': 'Kitchen or bar' },
      [['all', 'Both'], ['kitchen', 'Kitchen'], ['bar', 'Bar']].map(([k, label]) => h('button', { class: side === k ? 'on' : '', 'aria-pressed': String(side === k), text: label, onclick: () => { me.todaySide = k; draw(); } }))) : null;
    const chips = onSide.length > 4 && groups.size > 1 ? h('div', { class: 'row wrap', role: 'group', 'aria-label': 'Show' },
      TODAY_FILTERS.filter(([k]) => k === 'all' || groups.has(k)).map(([k, label]) => h('button', { class: `chip${filter === k ? ' on' : ''}`, 'aria-pressed': String(filter === k), text: label, onclick: () => { filter = k; draw(); } }))) : null;

    const need = onSide.filter((i) => i.tone !== 'info').length;
    const sub = [
      t.openToday ? null : `Closed today. Next service ${weekdayName(t.nextOpen)}.`,
      need ? `${need} thing${need === 1 ? '' : 's'} need${need === 1 ? 's' : ''} someone: deadlines first, then by dollars.` : 'Nothing needs anyone right now.',
      asleep.length ? `${asleep.length} snoozed.` : null,
    ].filter(Boolean).join(' ');
    // The list, in groups: by when it's needed, or by tab. Folded-up lines stay in their group.
    const grouping = 'time';
    const groupsOf = groupTodos(shown, t.today, grouping);
    const doneByGroup = new Map();
    for (const [key, d] of done) {
      if (side !== 'all' && d.item.side && d.item.side !== side) continue;
      const g = todoGroupKey(d.item, t.today, grouping);
      doneByGroup.set(g, [...(doneByGroup.get(g) ?? []), key]);
    }
    const sections = groupsOf.map((g) => {
      const rows = g.items.map(itemRow);
      for (const key of doneByGroup.get(g.key) ?? []) rows.splice(Math.min(done.get(key).indexIn ?? rows.length, rows.length), 0, doneRow(key));
      return todoSection(g, rows);
    });
    for (const [gk, keys] of doneByGroup) if (!groupsOf.some((g) => g.key === gk)) sections.push(todoSection(todoGroupInfo(gk, grouping), keys.map(doneRow)));

    show(shell(me, 'today', [
      h('header', { class: 'row wrap' },
        h('div', { class: 'grow' }, h('div', { class: 'kicker', text: `${longDay(t.today)} · ${me.restaurantName}` }), h('h1', { text: 'Today' }), h('div', { class: 'sub', text: sub })),
        h('div', { class: 'row wrap' }, sides)),
      t.glance ? homeTiles(me, t, side, onSide) : null,
      page([h('div', { class: 'row wrap todo-head' }, h('h2', { class: 'grow', text: 'To do' })),
        h('section', { class: 'todos', 'aria-label': 'To do' }, sections.length ? sections : h('div', { class: 'card small muted', text: asleep.length ? 'All clear, apart from what’s snoozed.' : 'All clear.' }), asleepBox)],
        [quiet, glanceCards(me, t, side, { home: Boolean(t.glance) })]),
    ]));
    errorFor = null;
  }
  draw();
}

/** Each tab's color: the edge of its tile on Today, its tag on a to-do, its icon in the rail. */
const TODO_TABS = {
  prep: { name: 'Prep', color: '#2E7D4F', go: (me) => prepHome(me) },
  orders: { name: 'Orders', color: '#A85400', go: (me) => ordersScreen(me) },
  menu: { name: 'Menu', color: '#1F5FA8', go: (me) => menuScreen(me) },
  recipes: { name: 'Recipes', color: '#0E7470', go: (me) => recipesScreen(me) },
  performance: { name: 'Performance', color: '#7A3E9D', go: (me) => marginsScreen(me) },
  reports: { name: 'Reports', color: '#3D3D3D', go: (me) => reportsScreen(me) },
  setup: { name: 'Settings', color: '#6B6B6B', go: (me) => home(me) },
};
const todoTab = (i) => ({ count: 'prep', review: 'prep', work: 'prep', order: 'orders', orders: 'orders', menu: 'menu', cards: 'recipes', drafts: 'recipes', performance: 'performance', settings: 'setup' })[i.go?.to] ?? (i.group === 'costs' ? 'performance' : i.group === 'setup' ? 'setup' : i.group);
const TIME_GROUPS = [['now', 'Today', 'Due today, or late'], ['soon', 'This week', 'Due in the next few days'], ['later', 'Whenever you can', 'No deadline']];
const plusDays = (d, n) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + n); return iso(x); };
function todoGroupKey(i, today, grouping) {
  if (grouping === 'tab') return todoTab(i);
  return i.due && i.due <= today ? 'now' : i.due && i.due <= plusDays(today, 7) ? 'soon' : 'later';
}
function todoGroupInfo(key, grouping) {
  if (grouping === 'tab') { const tb = TODO_TABS[key] ?? TODO_TABS.setup; return { key, title: tb.name, color: tb.color, items: [] }; }
  const [, title, note] = TIME_GROUPS.find(([k]) => k === key) ?? TIME_GROUPS[2];
  return { key, title, note, items: [] };
}
/** The to-dos in groups, in order: by when (today, this week, whenever) or by tab (in the rail's order). */
function groupTodos(items, today, grouping) {
  const order = grouping === 'tab' ? Object.keys(TODO_TABS) : TIME_GROUPS.map(([k]) => k);
  const by = new Map();
  for (const i of items) { const k = todoGroupKey(i, today, grouping); by.set(k, [...(by.get(k) ?? []), i]); }
  return order.filter((k) => by.has(k)).map((k) => ({ ...todoGroupInfo(k, grouping), items: by.get(k) }));
}
/** A group: its heading and count, the first few lines, and the rest behind "Show N more". */
function todoSection(g, rows) {
  const SHOW = 4;
  const head = h('div', { class: 'todo-group-head' }, h('h3', { text: g.title }), h('span', { class: 'small muted', text: `${rows.length}${g.note ? ` · ${g.note}` : ''}` }));
  if (g.color) head.style.setProperty('--tab', g.color);
  const box = h('div', { class: `todo-group${g.color ? ' tabbed' : ''}` }, head, rows.slice(0, SHOW));
  if (rows.length > SHOW) {
    const more = h('button', { class: 'link more-link', text: `Show ${rows.length - SHOW} more` });
    more.addEventListener('click', () => { more.replaceWith(...rows.slice(SHOW)); });
    box.append(more);
  }
  return box;
}

/** The home page's top row: one tile per tab, its color down the edge, one headline and a line under it. Each opens its tab. */
function homeTiles(me, t, side, items) {
  const g = t.glance?.[side];
  const count = (tab) => items.filter((i) => todoTab(i) === tab).length;
  const prep = t.prep.filter((s) => side === 'all' || s.side === side);
  const lists = prep.filter((s) => s.today?.total);
  const doneLists = lists.filter((s) => s.today.approved && !s.today.left).length;
  const tiles = [
    ['prep', lists.length ? `${doneLists} of ${lists.length} done` : t.openToday ? 'No prep today' : 'Closed today',
      lists.length ? lists.filter((s) => s.today.left).map((s) => `${s.station}: ${s.today.left} left`).slice(0, 2).join(' · ') || 'All lists finished' : prep.map((s) => `${s.station}: ${s.next.counted ?? 0}/${s.next.toCount ?? 0} counted`).slice(0, 2).join(' · ')],
    ['orders', count('orders') ? `${count('orders')} to look at` : 'Nothing due', items.filter((i) => todoTab(i) === 'orders').map((i) => i.title).slice(0, 1)[0] ?? 'Orders are on track'],
    ['menu', count('menu') ? `${count('menu')} question${count('menu') === 1 ? '' : 's'}` : 'Up to date', count('menu') ? 'Answer them here or on Menu' : 'No questions waiting'],
    ['performance', g?.lastDay ? dollars(g.lastDay.netSales, { exact: true }) : '–', g?.lastDay ? `Last service, ${weekdayName(g.lastDay.date)}${g.lastDay.usual ? ` · ${g.lastDay.netSales >= g.lastDay.usual ? '+' : '−'}${Math.abs(Math.round((g.lastDay.netSales / g.lastDay.usual - 1) * 100))}% vs usual` : ''}` : 'No sales yet'],
    ['recipes', g?.coverage ? `${Math.round((g.coverage.complete / Math.max(g.coverage.complete + g.coverage.gaps + g.coverage.noCard, 1e-9)) * 100)}% costed` : `${count('recipes')} to do`, g?.coverage ? `${g.coverage.noCardCount ?? 0} items without a recipe` : 'Recipes and costs'],
    ['reports', g?.weekToDate ? dollars(g.weekToDate.netSales, { exact: true }) : g?.lastWeek ? dollars(g.lastWeek.netSales, { exact: true }) : '–', g?.weekToDate ? `This week, through ${weekdayName(g.weekToDate.to)}` : 'Last week'],
  ];
  return h('nav', { class: 'home-tiles', 'aria-label': 'Each tab at a glance' }, tiles.map(([key, big, line]) => {
    const tab = TODO_TABS[key];
    const tile = h('button', { class: 'home-tile', onclick: () => tab.go(me) },
      h('span', { class: 'tile-name' }, icon(key === 'performance' ? 'margins' : key), tab.name),
      h('span', { class: 'tile-big', text: big }), h('span', { class: 'tile-line small muted', text: line }));
    tile.style.setProperty('--tab', tab.color);
    return tile;
  }));
}

function glanceCards(me, t, side, opts = {}) {
  const g = t.glance?.[side];
  const of = side === 'all' ? '' : `${AREA_NAMES[side]} · `;
  const cards = [];
  const versus = (now, then, words) => {
    if (!then) return null;
    const c = now / then - 1;
    return h('div', { class: `small ${c >= 0.03 ? 'trend-up' : c <= -0.03 ? 'trend-down' : 'trend-flat'}`, text: `${c >= 0 ? '+' : '−'}${Math.abs(Math.round(c * 100))}% ${words}` });
  };
  if (g?.coverage) cards.push(coverageCard(me, g.coverage, side));
  if (g?.lastDay && !opts.home) cards.push(h('div', { class: 'card tight' },
    h('div', { class: 'small muted strong', text: `${of}Last service · ${weekdayName(g.lastDay.date)} ${shortDate(g.lastDay.date)}` }),
    h('div', { class: 'big', text: dollars(g.lastDay.netSales, { exact: true }) }),
    versus(g.lastDay.netSales, g.lastDay.usual, `vs a usual ${weekdayName(g.lastDay.date)} (${dollars(g.lastDay.usual, { exact: true })})`)));
  if (opts.home) { /* the tiles show sales */ } else if (g?.weekToDate) cards.push(h('div', { class: 'card tight' },
    h('div', { class: 'small muted strong', text: `${of}This week, through ${weekdayName(g.weekToDate.to)}` }),
    h('div', { class: 'big', text: dollars(g.weekToDate.netSales, { exact: true }) }),
    versus(g.weekToDate.netSales, g.weekToDate.lastWeek, 'vs the same days last week')));
  else if (g?.lastWeek?.netSales) cards.push(h('div', { class: 'card tight' },
    h('div', { class: 'small muted strong', text: `${of}Last week, ${shortDate(g.lastWeek.from)} – ${shortDate(g.lastWeek.to)}` }),
    h('div', { class: 'big', text: dollars(g.lastWeek.netSales, { exact: true }) }),
    versus(g.lastWeek.netSales, g.lastWeek.before, 'vs the week before')));
  if (g?.earners?.length) cards.push(h('div', { class: 'card tight' },
    h('div', { class: 'small muted strong', text: 'Earning most, last 7 days' }),
    h('div', { class: 'list compact' }, g.earners.map((d) => h('div', {}, h('span', { class: 'grow', text: d.name }), h('span', { class: 'small muted', text: `${d.sold} sold` }), h('b', { text: dollars(d.left, { exact: true }) })))),
    h('div', { class: 'small muted', text: 'Estimated gross profit: sales minus the recipe’s food cost.' + (g.foodCost !== undefined ? ` Food cost over 90 days: ${pct(g.foodCost)}.` : '') })));
  else if (g?.sellers?.length) cards.push(h('div', { class: 'card tight' },
    h('div', { class: 'small muted strong', text: 'Selling most, last 7 days' }),
    h('div', { class: 'list compact' }, g.sellers.map((d) => h('div', {}, h('span', { class: 'grow', text: d.name }), h('span', { class: 'small muted', text: `${d.sold} sold` }), h('b', { text: dollars(d.netSales, { exact: true }) })))),
    h('div', { class: 'small muted', text: 'By sales: drinks have no costs yet.' })));
  if (t.prep.some((s) => side === 'all' || s.side === side)) cards.push(h('div', { class: 'card tight' },
    h('div', { class: 'small muted strong', text: 'Prep' }),
    h('div', { class: 'list compact' }, t.prep.filter((s) => side === 'all' || s.side === side).map((s) => {
      const today = s.today;
      const now = !t.openToday ? null : !today?.total ? 'nothing today' : !today.approved ? 'not approved' : today.left ? `${today.total - today.left} of ${today.total} done` : 'done';
      const next = s.next.approved ? `${weekdayName(s.next.date)}: approved` : s.next.toCount ? `${weekdayName(s.next.date)}: ${s.next.counted ? `${s.next.counted}/${s.next.toCount} counted` : 'not counted'}` : null;
      return h('div', {}, h('span', { class: 'grow', text: s.station }), h('span', { class: 'small muted right', text: [now, next].filter(Boolean).join(' · ') }));
    }))));
  if (g?.noCard?.length) cards.push(h('div', { class: 'card tight' },
    h('div', { class: 'small muted strong', text: 'Selling without a recipe' }),
    h('div', { class: 'small', text: g.noCard.map((d) => d.name).join(' · ') }),
    h('div', { class: 'small muted', text: 'Their food cost isn’t counted until a recipe is in.' })));
  return cards;
}

// ------------------------------------------------------------------ reports
// The weekly reports, for any period: how the money came in, tables and servers (team and
// sales), and every menu item by how it was ordered. Each set against the period before or the
// same weeks last year. Weeks run Monday to Sunday.

function reportPresets() {
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const day = (d) => iso(d);
  const back = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return d; };
  const monday = back((today.getDay() + 6) % 7); // this week's Monday
  const lastMon = new Date(monday); lastMon.setDate(lastMon.getDate() - 7);
  const lastSun = new Date(monday); lastSun.setDate(lastSun.getDate() - 1);
  const twoMon = new Date(monday); twoMon.setDate(twoMon.getDate() - 14);
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  const lmEnd = new Date(first); lmEnd.setDate(0);
  const lmStart = new Date(lmEnd.getFullYear(), lmEnd.getMonth(), 1);
  return [
    ['week', 'Last week', { from: day(lastMon), to: day(lastSun) }],
    ['two', 'Last 2 weeks', { from: day(twoMon), to: day(lastSun) }],
    ['month', lmStart.toLocaleDateString(undefined, { month: 'long' }), { from: day(lmStart), to: day(lmEnd) }],
    ['this', 'This month', { from: day(first), to: day(today) }],
    ['90', 'Last 90 days', { from: day(back(89)), to: day(today) }],
  ];
}

/** "▲ 12%" against the comparison; for rates, the difference in points. */
function versusCell(now, then, opts = {}) {
  if (then === undefined || then === null || now === undefined || now === null || (!opts.points && !then)) return h('span', { class: 'small muted vs', text: '–' });
  const d = opts.points ? (now - then) * 100 : (now / then - 1) * 100;
  const flat = Math.abs(d) < (opts.points ? 0.5 : 2);
  const cls = flat ? 'muted' : (d > 0) !== Boolean(opts.lowerIsBetter) ? 'trend-up' : 'trend-down';
  return h('span', { class: `small vs ${cls}`, title: opts.title ?? '', text: flat ? 'even' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(opts.points ? 1 : 0)}${opts.points ? ' pts' : '%'}` });
}
/** Whole dollars with a real minus sign; anything that rounds to nothing is $0. */
const signedDollars = (v) => { const r = Math.round(v); return r === 0 ? '$0' : `${r < 0 ? '−' : ''}${dollars(Math.abs(r), { exact: true })}`; };
const pct0 = (v) => (v === undefined || v === null ? '–' : `${(v * 100).toFixed(1)}%`);

async function reportsScreen(me, state = {}) {
  const presets = reportPresets();
  state = { report: 'sales', preset: 'two', compare: 'previous', sorts: {}, ...state };
  const range = state.range ?? presets.find(([k]) => k === state.preset)?.[2] ?? presets[1][2];
  if (state.report === 'prices') return pricesScreen(me, state, presets, range);
  loadingScreen(me, 'reports', 'Reports');
  const side = sideOf(me);
  const path = { sales: '/api/reports/sales?', menu: `/api/reports/menu?area=${side}&`, prime: '/api/reports/prime?', usage: `/api/reports/usage?area=${side}&`, hours: '/api/reports/hours?' }[state.report] ?? '/api/reports/sales?';
  const r = await api('GET', `${path}from=${range.from}&to=${range.to}`);
  if (!r.ok) return show(shell(me, 'reports', [h('header', {}, h('h1', { text: 'Reports' })), reportToolbar(me, state, range, presets, (c) => reportsScreen(me, { ...state, ...c })), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  renderReports(me, state, r.data, presets, range);
}

/** Draws a report already loaded: sorting a column redraws it without asking the server again. */
function renderReports(me, state, d, presets, range) {
  const again = (changes) => reportsScreen(me, { ...state, ...changes });
  const sortBy = (table) => ({ sort: state.sorts[table], onSort: (sort) => renderReports(me, { ...state, sorts: { ...state.sorts, [table]: sort } }, d, presets, range) });
  const side = sideOf(me);
  const lastYear = state.compare === 'lastYear';
  const base = lastYear ? d.lastYear : d.previous;
  const has = state.report === 'prime' ? (lastYear ? d.lastYearTotal : d.before) !== undefined : lastYear ? d.hasLastYear : d.hasPrevious;
  const compares = ['sales', 'menu', 'prime'].includes(state.report);
  const info = REPORTS[state.report];
  const header = h('header', { class: 'row wrap' },
    h('div', { class: 'grow' },
      h('div', { class: 'kicker', text: `${shortDate(d.from)} – ${shortDate(d.to)}${compares ? ` · ${has ? `against ${lastYear ? 'last year' : 'the period before'}, ${shortDate(base.from)} – ${shortDate(base.to)}` : 'nothing to set it against yet'}` : ''}` }),
      h('h1', { text: info.sided ? `${info.title} · ${AREA_NAMES[side]}` : info.title }),
      h('div', { class: 'sub', text: info.sub })),
    h('button', { class: 'btn', text: 'Print', onclick: () => window.print() }));
  const toolbar = reportToolbar(me, state, range, presets, again);
  if (state.report === 'prime') return show(shell(me, 'reports', [header, toolbar, primeView(d, lastYear)]));
  if (state.report === 'usage') return show(shell(me, 'reports', [header, toolbar, usageView(me, d, sortBy, state, presets, range)]));
  if (state.report === 'hours') return show(shell(me, 'reports', [header, toolbar, hoursView(d, state, (metric) => renderReports(me, { ...state, metric }, d, presets, range))]));
  if (!d.dataFrom) {
    return show(shell(me, 'reports', [header, toolbar, page(h('div', { class: 'card' }, h('h2', { text: 'Waiting for orders from Square' }),
      h('div', { class: 'small muted', text: 'Reports are built from each order: its table, covers, server and how it was placed. They come with the nightly Square sync, about a year back the first time, so a period can be set against last year. Sync now from Settings to start sooner.' }),
      h('div', {}, h('button', { class: 'btn', text: 'Settings', onclick: () => home(me) }))), null)]));
  }
  const early = d.from < d.dataFrom ? h('div', { class: 'note', text: `Orders are kept from ${shortDate(d.dataFrom)}, so this period starts there.` }) : null;
  const view = state.report === 'menu' ? menuReportView(d, lastYear, has, early, sortBy) : salesReportView(d, lastYear ? d.lastYearReport : d.before, lastYear, early, sortBy);
  show(shell(me, 'reports', [header, toolbar, view]));
}

/**
 * A table whose column titles sort it. columns: { key, label, num?, value?(row), cell(row, i), first? };
 * a column with no value doesn't sort. Rows with nothing to sort by stay at the bottom either way.
 */
function sortableRows(cls, columns, rows, { sort, onSort }, fallback) {
  const current = sort ?? fallback;
  const col = columns.find((c) => c.key === current.key && c.value) ?? columns.find((c) => c.key === fallback.key);
  const dir = current.dir === 'asc' ? 1 : -1;
  const sorted = [...rows].sort((a, b) => {
    const x = col.value(a), y = col.value(b);
    const nx = x === undefined || x === null || Number.isNaN(x), ny = y === undefined || y === null || Number.isNaN(y);
    if (nx || ny) return nx && ny ? 0 : nx ? 1 : -1;
    return (typeof x === 'string' ? x.localeCompare(y, undefined, { numeric: true }) : x - y) * dir;
  });
  const head = h('div', { class: `rrow head ${cls}`, role: 'row' }, columns.map((c) => {
    if (!c.value) return h('div', { class: c.num ? 'num' : '', text: c.label });
    const on = c.key === col.key;
    return h('button', { class: `sort${on ? ' on' : ''}${c.num ? ' num' : ''}`, 'aria-sort': on ? (dir === 1 ? 'ascending' : 'descending') : 'none',
      onclick: () => onSort({ key: c.key, dir: on ? (dir === 1 ? 'desc' : 'asc') : c.first ?? (c.num ? 'desc' : 'asc') }) }, c.label, h('span', { class: 'arrow', text: on ? (dir === 1 ? ' ▲' : ' ▼') : '' }));
  }));
  return [head, sorted.map((r, i) => h('div', { class: `rrow ${cls}` }, columns.map((c) => c.cell(r, i))))];
}

/** One row of filters: which report, which period (custom dates open in place), against what. */
function reportToolbar(me, state, range, presets, again) {
  const seg = (label, options) => h('div', { class: 'seg', role: 'group', 'aria-label': label },
    options.map(([text, on, go]) => h('button', { class: on ? 'on' : '', 'aria-pressed': String(on), text, onclick: go })));
  const custom = Boolean(state.range);
  const report = h('select', { class: 'tool-select', 'aria-label': 'Report' }, Object.entries(REPORTS).map(([k, r]) => h('option', { value: k, text: r.title, selected: k === state.report ? true : undefined })));
  report.addEventListener('change', () => {
    // Prime cost and recipes vs. purchases read wrong over a week or two (deliveries are lumpy): start them on last month.
    const days = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 + 1;
    const longer = ['prime', 'usage'].includes(report.value) && days < 28 ? { preset: 'month', range: undefined } : {};
    again({ report: report.value, sorts: {}, ...longer });
  });
  const info = REPORTS[state.report];
  return h('section', { class: 'card toolbar one-row' },
    h('div', { class: 'tool-field' }, h('span', { class: 'tool-label', text: 'Report' }), report),
    info.period ? periodPicker(presets, custom ? 'custom' : state.preset, range, (key, r) => again(key === 'custom' ? { range: r, preset: undefined } : { preset: key, range: undefined })) : null,
    info.compares ? h('div', { class: 'tool-field' }, h('span', { class: 'tool-label', text: 'Against' }),
      seg('Against', [['Period before', !lastYearOf(state), () => again({ compare: 'previous' })], ['Last year', lastYearOf(state), () => again({ compare: 'lastYear' })]])) : null,
    info.sided ? h('div', { class: 'tool-end' }, sideSwitch(me, () => again({}))) : null);
}
const lastYearOf = (state) => state.compare === 'lastYear';

/** The reports, in the order they're offered. */
const REPORTS = {
  sales: { title: 'Team and sales', period: true, compares: true, sub: 'How the money came in, each server on table orders, and every table. Automatic gratuity counts as tips, not sales. Click a column title to sort.' },
  menu: { title: 'Menu items', period: true, compares: true, sided: true, sub: 'Every item, ranked within its category, by how it was ordered. Specials are judged by what they sold a day while they were on. Click a column title to sort.' },
  prime: { title: 'Prime cost', period: true, compares: true, sub: 'Food and bar bought, plus hourly labor, as a share of sales, week by week. Weeks run Monday to Sunday.' },
  usage: { title: 'Recipes vs. purchases', period: true, sided: true, sub: 'What every dish sold should have used by its recipe, against what was bought. Over a month or more, the gap is waste, portions, comps and anything without a recipe.' },
  hours: { title: 'Sales and labor by hour', period: true, sub: 'An average open day for each weekday: sales, covers and the hours worked, spread over each shift.' },
  prices: { title: 'Ingredient prices', sided: true, sub: 'Follow a dish down to its ingredients, or search for one. Each ingredient shows what you’ve paid over time, and from which vendor.' },
};

/** A period dropdown: the presets with their dates, and custom dates that open beside it. */
function periodPicker(presets, current, range, pick) {
  const fromInput = h('input', { type: 'date', value: range.from, max: iso(new Date()), 'aria-label': 'From' });
  const toInput = h('input', { type: 'date', value: range.to, max: iso(new Date()), 'aria-label': 'To' });
  const dates = h('div', { class: 'row tight dates-inline' }, fromInput, h('span', { class: 'small muted', text: 'to' }), toInput,
    h('button', { class: 'btn small-btn', text: 'Show', onclick: () => fromInput.value && toInput.value && fromInput.value <= toInput.value && pick('custom', { from: fromInput.value, to: toInput.value }) }));
  dates.hidden = current !== 'custom';
  const span = (r) => (r ? ` · ${shortDate(r.from)} – ${shortDate(r.to)}` : '');
  const select = h('select', { class: 'tool-select', 'aria-label': 'Period' },
    presets.map(([k, label, r]) => h('option', { value: k, text: `${label}${span(r)}`, selected: k === current ? true : undefined })),
    h('option', { value: 'custom', text: current === 'custom' ? `Custom${span(range)}` : 'Custom dates…', selected: current === 'custom' ? true : undefined }));
  select.addEventListener('change', () => {
    if (select.value === 'custom') { dates.hidden = false; fromInput.focus(); return; }
    pick(select.value);
  });
  return h('div', { class: 'tool-field' }, h('span', { class: 'tool-label', text: 'Period' }), select, dates);
}

const WEEKDAYS_LONG = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
/** The change against the comparison, as a number to sort by (undefined when there's nothing to compare). */
const changeOf = (now, then, points) => (now === undefined || now === null || then === undefined || then === null || (!points && !then) ? undefined : points ? now - then : now / then - 1);

function salesReportView(d, then, lastYear, early, sortBy) {
  const c = d.current;
  const word = lastYear ? 'last year' : 'the period before';
  const vsLabel = lastYear ? 'vs last year' : 'vs before';
  const bar = (v, max) => { const b = h('span', { class: 'hbar-track' }, h('span', { class: 'hbar-fill' })); b.firstChild.style.width = `${(v / max) * 100}%`; return b; };
  // How the money came in.
  const maxType = Math.max(...c.byType.map((t) => t.sales), 1);
  const wasType = (t) => then?.byType.find((x) => x.type === t.type);
  const types = h('section', { class: 'card' }, h('h2', { text: 'How the money came in' }),
    h('div', { class: 'rtable' }, sortableRows('types', [
      { key: 'name', label: 'Order type', value: (t) => t.name, cell: (t) => h('div', { class: 'strong', text: t.name }) },
      { key: 'sales', label: 'Sales', num: true, value: (t) => t.sales, cell: (t) => h('div', { class: 'num', text: dollars(t.sales, { exact: true }) }) },
      { key: 'share', label: 'Share', value: (t) => t.share, first: 'desc', cell: (t) => h('div', { class: 'row tight' }, bar(t.sales, maxType), h('span', { class: 'small muted', text: `${Math.round(t.share * 100)}%` })) },
      { key: 'orders', label: 'Orders', num: true, value: (t) => t.orders, cell: (t) => h('div', { class: 'num', text: t.orders.toLocaleString() }) },
      { key: 'average', label: 'Average', num: true, value: (t) => t.average, cell: (t) => h('div', { class: 'num', text: dollars(t.average ?? 0, { cents: true }) }) },
      { key: 'vs', label: vsLabel, num: true, value: (t) => changeOf(t.sales, wasType(t)?.sales), cell: (t) => h('div', { class: 'num' }, versusCell(t.sales, wasType(t)?.sales)) },
    ], c.byType, sortBy('types'), { key: 'sales', dir: 'desc' })),
    h('div', { class: 'small muted', text: 'Table orders have a table; register orders without one are to go, however they were rung; online is Square Online.' }));
  // Servers: table orders only.
  const wasServer = (sv) => then?.servers.find((x) => x.name === sv.name);
  const servers = h('section', { class: 'card' }, h('h2', { text: 'Servers' }),
    h('div', { class: 'small muted', text: `Table orders only. Tip rate includes automatic gratuity. Wine is set against covers${c.wineDaysLeftOut.length ? `, leaving out ${c.wineDaysLeftOut.map((w) => WEEKDAYS_LONG[w]).join(' and ')} (wine is discounted)` : ''}. The small line under a rate is its change ${vsLabel.replace('vs ', 'against ')}.` }),
    h('div', { class: 'rtable' }, sortableRows('servers', [
      { key: 'name', label: 'Server', value: (sv) => sv.name, cell: (sv) => h('div', { class: 'strong', text: sv.name }) },
      { key: 'covers', label: 'Covers', num: true, value: (sv) => sv.covers, cell: (sv) => h('div', { class: 'num', text: sv.covers.toLocaleString() }) },
      { key: 'sales', label: 'Sales', num: true, value: (sv) => sv.sales, cell: (sv) => h('div', { class: 'num', text: dollars(sv.sales, { exact: true }) }) },
      { key: 'coverRate', label: 'Cover rate', num: true, value: (sv) => sv.coverRate, cell: (sv) => h('div', { class: 'num' }, h('div', { text: dollars(sv.coverRate ?? 0, { cents: true }) }), versusCell(sv.coverRate, wasServer(sv)?.coverRate)) },
      { key: 'tipRate', label: 'Tip rate', num: true, value: (sv) => sv.tipRate, cell: (sv) => h('div', { class: 'num' }, h('div', { text: pct0(sv.tipRate) }), versusCell(sv.tipRate, wasServer(sv)?.tipRate, { points: true })) },
      { key: 'wine', label: 'Wine: glass | bottle', num: true, value: (sv) => sv.wine, cell: (sv) => h('div', { class: 'num small', text: `${dollars(sv.wineGlass, { exact: true })} | ${dollars(sv.wineBottle, { exact: true })}` }) },
      { key: 'winePerCover', label: 'Wine per cover', num: true, value: (sv) => sv.winePerCover, cell: (sv) => h('div', { class: 'num' }, h('div', { text: sv.winePerCover !== undefined ? dollars(sv.winePerCover, { cents: true }) : '–' }), versusCell(sv.winePerCover, wasServer(sv)?.winePerCover)) },
    ], c.servers, sortBy('servers'), { key: 'sales', dir: 'desc' })));
  // Tables.
  const maxTable = Math.max(...c.tables.map((t) => t.sales), 1);
  const wasTable = (t) => then?.tables.find((x) => x.table === t.table);
  const tables = h('section', { class: 'card' }, h('h2', { text: 'Tables' }),
    h('div', { class: 'rtable' }, sortableRows('tables', [
      { key: 'table', label: 'Table', value: (t) => t.table, cell: (t) => h('div', { class: 'strong', text: t.table }) },
      { key: 'turns', label: 'Turns', num: true, value: (t) => t.turns, cell: (t) => h('div', { class: 'num', text: String(t.turns) }) },
      { key: 'covers', label: 'Covers', num: true, value: (t) => t.covers, cell: (t) => h('div', { class: 'num', text: String(t.covers) }) },
      { key: 'perTurn', label: 'Per turn', num: true, value: (t) => t.coversPerTurn, cell: (t) => h('div', { class: 'num', text: t.coversPerTurn ?? '–' }) },
      { key: 'sales', label: 'Sales', value: (t) => t.sales, first: 'desc', cell: (t) => h('div', { class: 'row tight' }, bar(t.sales, maxTable), h('span', { class: 'small', text: dollars(t.sales, { exact: true }) })) },
      { key: 'coverRate', label: 'Cover rate', num: true, value: (t) => t.coverRate, cell: (t) => h('div', { class: 'num', text: t.coverRate !== undefined ? dollars(t.coverRate, { cents: true }) : '–' }) },
      { key: 'vs', label: vsLabel, num: true, value: (t) => changeOf(t.sales, wasTable(t)?.sales), cell: (t) => h('div', { class: 'num' }, versusCell(t.sales, wasTable(t)?.sales)) },
    ], c.tables, sortBy('tables'), { key: 'table', dir: 'asc' })),
    h('div', { class: 'small muted', text: 'A turn is one order at the table. Tables pushed together are rung under one of them.' }));
  // The right column: the headline numbers, and how the money came in as a share.
  const stat = (title, value, now, thenV, opts) => statBox(title, value, h('div', { class: 'row tight' }, versusCell(now, thenV, opts), h('span', { class: 'small muted', text: then ? `vs ${word}` : '' })));
  const side = [
    stat('Net sales', dollars(c.totals.sales, { exact: true }), c.totals.sales, then?.totals.sales),
    stat('Covers · table orders', c.totals.covers.toLocaleString(), c.totals.covers, then?.totals.covers),
    stat('Cover rate', dollars(c.totals.coverRate ?? 0, { cents: true }), c.totals.coverRate, then?.totals.coverRate),
    stat('Tip rate · table orders', pct0(c.totals.tipRate), c.totals.tipRate, then?.totals.tipRate, { points: true }),
    (() => { const dn = shareDonut(c.byType.map((t) => ({ name: t.name, value: t.sales })), { format: dollars, total: 'net sales' }); return dn ? sideBox('Sales by order type', dn) : null; })(),
    sideBox(null, h('div', { class: 'small muted', text: `${c.totals.orders.toLocaleString()} orders over ${c.days} open days. Cover rate is sales per cover on table orders.` })),
  ];
  return h('div', { class: 'report-print' }, page([early, types, servers, tables], side, { label: 'Summary' }));
}

function menuReportView(d, lastYear, has, early, sortBy) {
  const word = lastYear ? 'last year' : 'the period before';
  const ch = (i) => (lastYear ? i.lastYearChange : i.change);
  const cards = d.categories.map((cat) => {
    const maxQ = Math.max(...cat.items.map((i) => i.quantity), 1);
    const rank = new Map(cat.items.map((it, n) => [it, n + 1])); // by sales, whatever the sort
    return h('section', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { class: 'grow', text: cat.name }), h('span', { class: 'small muted', text: `${dollars(cat.sales, { exact: true })} · ${cat.items.length} items` })),
      h('div', { class: 'rtable' }, sortableRows('items', [
        { key: 'rank', label: '#', value: (it) => rank.get(it), first: 'asc', cell: (it) => h('div', { class: 'muted', text: String(rank.get(it)) }) },
        { key: 'name', label: 'Item', value: (it) => it.name, cell: (it) => h('div', {}, h('div', { class: 'strong', text: it.name }), it.daysOn < d.openDays ? h('div', { class: 'small muted', text: `on ${it.daysOn} of ${d.openDays} days` }) : null) },
        { key: 'sold', label: 'Sold: table | to go | online', value: (it) => it.quantity, first: 'desc', cell: (it) => {
          const mix = h('span', { class: 'mix', title: `Table ${qty(it.byType.table)} · to go ${qty(it.byType.register)} · online ${qty(it.byType.online)}` });
          for (const [k, cls] of [['table', 'mix-table'], ['register', 'mix-togo'], ['online', 'mix-online']]) { const seg = h('span', { class: cls }); seg.style.width = `${(it.byType[k] / maxQ) * 100}%`; mix.append(seg); }
          return h('div', {}, mix, h('div', { class: 'small muted', text: `${qty(it.quantity)} · ${qty(it.byType.table)} | ${qty(it.byType.register)} | ${qty(it.byType.online)}` }));
        } },
        { key: 'perDay', label: 'Per day on', num: true, value: (it) => it.perDay, cell: (it) => h('div', { class: 'num', text: qty(it.perDay) }) },
        { key: 'sales', label: 'Sales', num: true, value: (it) => it.sales, cell: (it) => h('div', { class: 'num', text: dollars(it.sales, { exact: true }) }) },
        { key: 'vs', label: lastYear ? 'vs last year' : 'vs before', num: true, value: (it) => ch(it), cell: (it) => h('div', { class: 'num' }, ch(it) === undefined ? h('span', { class: 'small muted', text: has ? 'new' : '–' }) : versusCell(1 + ch(it), 1, { title: 'Sold per day on, against the comparison' })) },
      ], cat.items, sortBy('items'), { key: 'rank', dir: 'asc' })));
  });
  // Right column: categories as a share, the order-type mix, and the biggest movers.
  const all = d.categories.flatMap((c) => c.items);
  const sum = (k) => all.reduce((a, i) => a + i.byType[k], 0);
  const total = sum('table') + sum('register') + sum('online');
  const movers = all.filter((i) => ch(i) !== undefined && i.perDay >= 1);
  const up = [...movers].sort((a, b) => ch(b) - ch(a)).filter((i) => ch(i) > 0.05).slice(0, 4);
  const down = [...movers].sort((a, b) => ch(a) - ch(b)).filter((i) => ch(i) < -0.05).slice(0, 4);
  const side = [
    (() => {
      const dn = drillDonut({ title: 'sales', crumb: 'Categories', format: dollars, items: d.categories.map((c) => ({ name: c.name, value: c.sales,
        open: () => ({ title: 'sales', items: c.items.map((i) => ({ name: i.name, value: i.sales, ...(i.variations ? { open: () => ({ title: 'sales', items: i.variations.map((v) => ({ name: `${v.name} (${qty(v.quantity)} sold)`, value: v.sales })) }) } : {}) })) }) })) });
      return dn ? sideBox('Sales by category', dn, h('div', { class: 'small muted', text: 'Click a category for its items, and an item sold more than one way (size, glass or bottle, a discount day) for those.' })) : null;
    })(),
    total ? sideBox('How items were ordered', h('div', { class: 'list compact' },
      [['Table orders', 'table', 'mix-table'], ['To go at the register', 'register', 'mix-togo'], ['Online', 'online', 'mix-online']].map(([label, k, cls]) => h('div', {}, h('span', { class: `cov-key ${cls}` }), h('span', { class: 'grow', text: label }), h('b', { text: `${Math.round((sum(k) / total) * 100)}%` }), h('span', { class: 'small muted', text: qty(Math.round(sum(k))) }))))) : null,
    up.length || down.length ? sideBox(`Moving, against ${word}`, h('div', { class: 'list compact' },
      up.map((i) => h('div', {}, h('span', { class: 'grow', text: i.name }), h('b', { class: 'trend-up', text: `▲ ${Math.round(ch(i) * 100)}%` }))),
      down.map((i) => h('div', {}, h('span', { class: 'grow', text: i.name }), h('b', { class: 'trend-down', text: `▼ ${Math.abs(Math.round(ch(i) * 100))}%` })))),
      h('div', { class: 'small muted', text: 'Sold per day on the menu, for items selling at least one a day.' })) : null,
  ];
  return h('div', { class: 'report-print' }, page([early, ...cards], side, { label: 'Summary' }));
}

/** Prime cost: weeks as stacked bars (food, bar, labor as a share of sales), the weeks as a table, the totals beside. */
function primeView(d, lastYear) {
  const parts = [['food', 'Food', SERIES[0]], ['bar', 'Bar', SERIES[1]], ['labor', 'Labor', SERIES[2]]];
  const weeks = d.weeks.filter((w) => w.sales > 0);
  const then = lastYear ? d.lastYearTotal : d.before;
  const word = lastYear ? 'last year' : 'the period before';
  const W = 760, H = 260, L = 44, R = 12, T = 18, B = 30;
  const top = Math.max(0.5, Math.ceil(Math.max(...weeks.map((w) => w.primeShare ?? 0), 0.3) * 10) / 10);
  const band = (W - L - R) / Math.max(weeks.length, 1), bw = Math.min(46, band * 0.66);
  const y = (v) => T + (1 - v / top) * (H - T - B);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': weeks.map((w) => `Week of ${shortDate(w.week)}: prime cost ${pct0(w.primeShare)}`).join('; ') });
  for (let k = 0; k <= 4; k++) { const v = (top / 4) * k; svg.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: k ? 'grid' : 'axis' }), s('text', { x: L - 8, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }, document.createTextNode(`${Math.round(v * 100)}%`))); }
  const wrap = h('div', { class: 'chart' }, svg);
  const tip = tooltipBox(wrap);
  weeks.forEach((w, i) => {
    const cx = L + band * i + band / 2;
    svg.append(s('text', { x: cx, y: H - 10, class: 'tick', 'text-anchor': 'middle' }, document.createTextNode(shortDate(w.week))));
    let base = 0;
    const segs = parts.map(([k, label, color]) => ({ k, label, color, v: w[`${k}Share`] ?? 0 })).filter((x) => x.v > 0);
    segs.forEach((g, j) => {
      const y0 = y(base), y1 = y(base + g.v), hgt = Math.max(0, y0 - y1 - (j ? 2 : 0));
      const rect = s(j === segs.length - 1 ? 'path' : 'rect', j === segs.length - 1 ? { d: roundedTop(cx - bw / 2, y1, bw, hgt, Math.min(4, hgt)), fill: g.color, class: 'seg', tabindex: 0 } : { x: cx - bw / 2, y: y1, width: bw, height: hgt, fill: g.color, class: 'seg', tabindex: 0 });
      const showTip = () => { const box = svg.getBoundingClientRect(), wb = wrap.getBoundingClientRect(); tip.show((cx / W) * box.width + box.left - wb.left, (y1 / H) * box.height, `Week of ${shortDate(w.week)} · prime ${pct0(w.primeShare)}`, parts.map(([k, label, color]) => [color, `${pct0(w[`${k}Share`])} · ${dollars(w[k], { exact: true })}`, label])); };
      rect.addEventListener('pointerenter', showTip); rect.addEventListener('focus', showTip); rect.addEventListener('pointerleave', () => tip.hide()); rect.addEventListener('blur', () => tip.hide());
      svg.append(rect);
      base += g.v;
    });
    svg.append(s('text', { x: cx, y: y(base) - 5, class: 'tick strong-tick', 'text-anchor': 'middle' }, document.createTextNode(`${Math.round((w.primeShare ?? 0) * 100)}%`)));
  });
  const chart = h('section', { class: 'card' }, h('h2', { text: 'Prime cost, week by week' }),
    legend(parts.map(([, label, color]) => ({ name: label, color, on: true, fixed: true }))), weeks.length ? wrap : h('div', { class: 'small muted', text: 'No sales in this period.' }),
    h('div', { class: 'small muted', text: 'Each bar is a share of that week’s sales; the number on top is prime cost. Hover a block for its dollars.' }));
  const table = h('section', { class: 'card' }, h('h2', { text: 'The weeks' }),
    h('div', { class: 'rtable' },
      h('div', { class: 'rrow head prime' }, ['Week', 'Sales', 'Food', 'Bar', 'Labor', 'Hours', 'Prime'].map((t, i) => h('div', { class: i ? 'num' : '', text: t }))),
      d.weeks.map((w) => h('div', { class: 'rrow prime' }, h('div', { class: 'strong', text: `${shortDate(w.week)}${w.days < 5 ? ` (${w.days} days)` : ''}` }),
        h('div', { class: 'num', text: dollars(w.sales, { exact: true }) }),
        ...['food', 'bar', 'labor'].map((k) => h('div', { class: 'num' }, h('div', { text: dollars(w[k], { exact: true }) }), h('div', { class: 'small muted', text: pct0(w[`${k}Share`]) }))),
        h('div', { class: 'num', text: qty(w.laborHours) }),
        h('div', { class: 'num strong', text: pct0(w.primeShare) })))),
    h('div', { class: 'small muted', text: `Food and bar are what was bought that week, by invoice date: a big delivery lands in one week, so read a month at a time. Labor is clocked hours × base wage from Square: no overtime premiums, payroll taxes or salaried pay. Invoices from ${d.dataFrom.invoices ? dateWithYear(d.dataFrom.invoices) : '–'}, timecards from ${d.dataFrom.labor ? dateWithYear(d.dataFrom.labor) : '–'}.` }));
  const t = d.total;
  const stat = (title, key) => statBox(title, pct0(t[key]), h('div', { class: 'row tight' }, versusCell(t[key], then?.[key], { points: true, lowerIsBetter: true }), h('span', { class: 'small muted', text: then ? `vs ${word}` : '' })));
  const side = [
    statBox('Prime cost', pct0(t.primeShare), h('div', { class: 'small muted', text: `${dollars(t.prime, { exact: true })} on ${dollars(t.sales, { exact: true })} of sales` }), h('div', { class: 'row tight' }, versusCell(t.primeShare, then?.primeShare, { points: true, lowerIsBetter: true }), h('span', { class: 'small muted', text: then ? `vs ${word}` : '' }))),
    stat('Food', 'foodShare'), stat('Bar', 'barShare'), stat('Labor', 'laborShare'),
    d.byJob.length ? sideBox('Labor by job', h('div', { class: 'list compact' }, d.byJob.slice(0, 10).map((j) => h('div', {}, h('span', { class: 'grow', text: j.job }), h('span', { class: 'small muted', text: `${qty(j.hours)} h` }), h('b', { text: dollars(j.cost, { exact: true }) }))))) : null,
  ];
  return h('div', { class: 'report-print' }, page([chart, table], side, { label: 'Summary' }));
}

/** Recipes vs. purchases: product by product, sortable; what's bought with no recipe; the totals. */
function usageView(me, d, sortBy, state, presets, range) {
  const open = (r) => pricesScreen(me, { ...state, report: 'prices', trail: [{ kind: 'product', id: r.productId, name: r.name }] }, presets, range);
  const rows = h('div', { class: 'rtable' }, sortableRows('usage', [
    { key: 'name', label: 'Ingredient', value: (r) => r.name, cell: (r) => h('div', {}, h('button', { class: 'linkish strong', text: r.name, onclick: () => open(r) })) },
    { key: 'bought', label: 'Bought', num: true, value: (r) => r.bought, cell: (r) => h('div', { class: 'num', text: dollars(r.bought, { exact: true }) }) },
    { key: 'expected', label: 'Recipes used', num: true, value: (r) => r.expected, cell: (r) => h('div', { class: 'num', text: dollars(r.expected, { exact: true }) }) },
    { key: 'gap', label: 'Gap', num: true, value: (r) => r.gap, cell: (r) => h('div', { class: `num strong ${r.gap >= 1 ? 'warn-text' : ''}`, text: signedDollars(r.gap) }) },
    { key: 'share', label: 'Of what was bought', num: true, value: (r) => r.share, cell: (r) => h('div', { class: 'num small', text: r.share !== undefined ? `${r.share < 0 ? '−' : ''}${pct0(Math.abs(r.share))}` : '–' }) },
  ], d.rows, sortBy('usage'), { key: 'gap', dir: 'desc' }));
  const short = d.days < 28 ? h('div', { class: 'note', text: `${d.days} days is short for this: what's bought in a week isn't what's used that week. Four weeks or more reads truer.` }) : null;
  const main = [short,
    h('section', { class: 'card' }, h('h2', { text: 'Ingredient by ingredient' }),
      h('div', { class: 'small muted', text: 'Bought is what the invoices charged. Recipes used is each dish sold × its recipe, at today’s prices. A gap above zero is money the recipes don’t explain. Click an ingredient for its price over time.' }), rows),
    d.notOnRecipes.length ? h('section', { class: 'card' }, h('h2', { text: `Bought, but no recipe uses it (${d.notOnRecipes.length})` }),
      h('div', { class: 'small muted', text: 'Either it goes into something without a recipe yet, or it’s not food (supplies filed as food).' }),
      h('div', { class: 'list compact' }, d.notOnRecipes.slice(0, 25).map((r) => h('div', {}, h('button', { class: 'linkish grow', text: r.name, onclick: () => open(r) }), h('b', { text: dollars(r.bought, { exact: true }) }))))) : null];
  const t = d.totals;
  const side = [
    t.gap >= 0
      ? statBox('Not explained by recipes', dollars(t.gap, { exact: true }), h('div', { class: 'small muted', text: `${t.bought ? pct0(t.gap / t.bought) : '–'} of the ${dollars(t.bought, { exact: true })} bought for ingredients the recipes use (${dollars(t.expected, { exact: true })} accounted for).` }))
      : statBox('Recipes used more than was bought', dollars(-t.gap, { exact: true }), h('div', { class: 'small muted', text: `Recipes account for ${dollars(t.expected, { exact: true })}, but only ${dollars(t.bought, { exact: true })} was bought: the shelves ran down, or some invoices aren’t in MarginEdge yet. Common over a short period.` })),
    t.boughtOff ? statBox('Bought with no recipe', dollars(t.boughtOff, { exact: true }), h('div', { class: 'small muted', text: 'Ingredients no recipe uses yet.' })) : null,
    d.noRecipeSales ? sideBox('Selling with no recipe', h('div', { class: 'small', text: `${dollars(d.noRecipeSales, { exact: true })} of sales have no recipe, so what they used shows as a gap here.` }), sideActions(h('button', { class: 'btn small-btn', text: 'See what’s missing', onclick: () => coverageScreen(me) }))) : null,
    sideBox('How to read it', h('div', { class: 'small muted', text: 'There are no stock counts, so this assumes the shelves end the period about where they started. The biggest gaps are where to look: portions, waste, comps, or a recipe that’s missing an amount.' })),
  ];
  return h('div', { class: 'report-print' }, page(main, side, { label: 'Summary' }));
}

const HOUR_METRICS = [['sales', 'Sales'], ['covers', 'Covers'], ['laborHours', 'Labor hours'], ['perLaborHour', 'Sales per labor hour']];
const hourLabel = (h24) => `${((h24 + 11) % 12) + 1}${h24 < 12 ? 'am' : 'pm'}`;
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Sales and labor by weekday and hour: a grid shaded by the chosen measure, darker for more. */
function hoursView(d, state, pickMetric) {
  const metric = state.metric ?? 'sales';
  const fmt = { sales: (v) => dollars(v), covers: (v) => qty(v), laborHours: (v) => qty(v), perLaborHour: (v) => dollars(v) }[metric];
  const cell = new Map(d.cells.map((c) => [`${c.weekday}|${c.hour}`, c]));
  const values = d.cells.map((c) => c[metric]).filter((v) => v !== undefined && v > 0);
  const max = Math.max(...values, 1);
  const seg = h('div', { class: 'seg wrap-seg', role: 'group', 'aria-label': 'Show' }, HOUR_METRICS.map(([k, label]) => h('button', { class: k === metric ? 'on' : '', 'aria-pressed': String(k === metric), text: label, onclick: () => pickMetric(k) })));
  const grid = h('div', { class: 'heat' },
    h('div'), d.weekdays.map((w) => h('div', { class: 'heat-head', text: `${DAY_SHORT[w]} (${d.days[w]})` })),
    d.hours.map((hr) => [h('div', { class: 'heat-hour', text: hourLabel(hr) }), d.weekdays.map((w) => {
      const c = cell.get(`${w}|${hr}`);
      const v = c?.[metric];
      const box = h('div', { class: 'heat-cell', title: c ? `${DAY_SHORT[w]} ${hourLabel(hr)}: ${dollars(c.sales)} sales, ${qty(c.covers)} covers, ${qty(c.laborHours)} labor hours${c.perLaborHour ? `, ${dollars(c.perLaborHour)} per labor hour` : ''}` : '' }, v ? fmt(v) : '');
      // One hue, light to dark: more is darker.
      const k = v ? Math.max(0.06, v / max) : 0;
      box.style.background = k ? `rgba(31, 79, 143, ${(0.08 + k * 0.82).toFixed(3)})` : 'var(--soft)';
      if (k > 0.55) box.classList.add('dark');
      return box;
    })]));
  grid.style.gridTemplateColumns = `56px repeat(${d.weekdays.length}, minmax(0, 1fr))`;
  const ranked = d.cells.filter((c) => c.perLaborHour !== undefined && c.laborHours >= 1 && c.sales > 0);
  const low = [...ranked].sort((a, b) => a.perLaborHour - b.perLaborHour).slice(0, 4);
  const busiest = [...d.cells].sort((a, b) => b.sales - a.sales).slice(0, 4);
  const totals = d.weekdays.map((w) => ({ w, sales: d.cells.filter((c) => c.weekday === w).reduce((a, c) => a + c.sales, 0), hours: d.cells.filter((c) => c.weekday === w).reduce((a, c) => a + c.laborHours, 0) }));
  const main = h('section', { class: 'card' }, h('div', { class: 'row wrap' }, h('h2', { class: 'grow', text: 'An average day, hour by hour' }), seg),
    d.hasLabor ? null : h('div', { class: 'note', text: 'No timecards in this period yet, so labor is empty. They come with the next Square sync.' }),
    d.hours.length ? grid : h('div', { class: 'small muted', text: 'No sales by hour in this period yet. They come with the next Square sync.' }),
    h('div', { class: 'small muted', text: 'Each cell is the average for that weekday’s open days in the period (the number of days is in brackets). Labor counts each shift in the hours it was worked. Hover a cell for all of it.' }));
  const side = [
    sideBox('A usual day', h('div', { class: 'list compact' }, totals.map((t) => h('div', {}, h('span', { class: 'grow', text: DAY_SHORT[t.w] }), h('span', { class: 'small muted', text: `${qty(Math.round(t.hours))} h` }), h('b', { text: dollars(t.sales) }))))),
    busiest.length ? sideBox('Busiest hours', h('div', { class: 'list compact' }, busiest.map((c) => h('div', {}, h('span', { class: 'grow', text: `${DAY_SHORT[c.weekday]} ${hourLabel(c.hour)}` }), h('b', { text: dollars(c.sales) }))))) : null,
    low.length ? sideBox('Most hours for the sales', h('div', { class: 'list compact' }, low.map((c) => h('div', {}, h('span', { class: 'grow', text: `${DAY_SHORT[c.weekday]} ${hourLabel(c.hour)}` }), h('span', { class: 'small muted', text: `${qty(c.laborHours)} h` }), h('b', { text: `${dollars(c.perLaborHour)}/h` })))),
      h('div', { class: 'small muted', text: 'Sales per labor hour, lowest first: where a shift might start later or end sooner. Prep before opening shows here too.' })) : null,
  ];
  return h('div', { class: 'report-print' }, page(main, side, { label: 'Summary' }));
}

// ------------------------------------------------------------------ ingredient prices

/** Answers already fetched this visit, so stepping back up the trail is instant. */
const costCache = new Map();
async function costGet(path) {
  if (costCache.has(path)) return costCache.get(path);
  const r = await api('GET', path);
  if (r.ok) costCache.set(path, r);
  return r;
}
/** A price per unit, with enough decimals that small units still show a difference. */
const perUnitText = (v, unit) => (v === undefined || v === null ? '–' : `$${v >= 10 ? v.toFixed(2) : v >= 0.1 ? v.toFixed(3) : v.toFixed(4)}${unit ? `/${unit}` : ''}`);
const unitAmount = (a, unit) => `${qty(Math.round(a * 1000) / 1000)} ${unit}`;
const changeText = (v) => (v === undefined || v === null ? '–' : `${v > 0 ? '▲' : v < 0 ? '▼' : ''} ${Math.abs(v * 100).toFixed(1)}%`);
const changeClass = (v) => (v === undefined || v === null || Math.abs(v) < 0.02 ? 'muted' : v > 0 ? 'warn-text' : 'good-text');

/**
 * Ingredient prices: start at the menu, step down a dish to its recipes and ingredients
 * (margherita → dough → flour), each step showing what that much of it costs; or search.
 * An ingredient shows every price paid, colored by vendor, with the switches between vendors.
 */
async function pricesScreen(me, state, presets, range) {
  const trail = state.trail ?? [];
  const node = trail[trail.length - 1];
  const side = sideOf(me);
  const go = (nextTrail) => pricesScreen(me, { ...state, trail: nextTrail }, presets, range);
  const again = (changes) => reportsScreen(me, { ...state, ...changes });
  const q = (n) => (n.amount ? `?amount=${n.amount}&unit=${encodeURIComponent(n.unit)}` : '');
  const path = !node ? `/api/costs/dishes?area=${side}` : node.kind === 'recipe' ? `/api/costs/recipe/${encodeURIComponent(node.id)}${q(node)}` : `/api/costs/product/${encodeURIComponent(node.id)}${q(node)}`;
  if (!costCache.has(path)) loadingScreen(me, 'reports', 'Ingredient prices');
  const [r, movers] = await Promise.all([costGet(path), costGet(`/api/costs/movers?area=${side}`)]);
  const info = REPORTS.prices;
  const header = h('header', { class: 'row wrap' },
    h('div', { class: 'grow' }, h('div', { class: 'kicker', text: 'Prices from MarginEdge invoices' }),
      h('h1', { text: `${info.title} · ${AREA_NAMES[side]}` }), h('div', { class: 'sub', text: info.sub })),
    h('button', { class: 'btn', text: 'Print', onclick: () => window.print() }));
  const toolbar = reportToolbar(me, state, range, presets, (c) => again({ ...c, trail: c.report && c.report !== 'prices' ? undefined : [] }));
  if (!r.ok) return show(shell(me, 'reports', [header, toolbar, h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const d = r.data;

  // The trail: Menu › Margherita $1.68 › Pizza Dough $0.33 › Flour $0.32. Each step goes back there.
  const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Where you are' },
    h('button', { class: `crumb${node ? '' : ' on'}`, onclick: () => go([]) }, h('span', { text: `${AREA_NAMES[side]} menu` })),
    trail.map((n, i) => [h('span', { class: 'crumb-sep', 'aria-hidden': 'true', text: '›' }),
      h('button', { class: `crumb${i === trail.length - 1 ? ' on' : ''}`, 'aria-current': i === trail.length - 1 ? 'page' : undefined, onclick: () => go(trail.slice(0, i + 1)) },
        h('span', { text: n.name }), n.cost !== undefined ? h('b', { text: dollars(n.cost, { cents: true }) }) : null)]));

  const search = searchBox((hit) => go([hit]));
  const moverBox = (title, rows, note) => (rows?.length ? sideBox(title, h('div', { class: 'list compact' }, rows.map((m) =>
    h('button', { class: 'linkish lrow', onclick: () => go([{ kind: 'product', id: m.id, name: m.name }]) },
      h('span', { class: 'grow', text: m.name }), h('span', { class: `small nowrap ${changeClass(m.change90)}`, text: changeText(m.change90) }), h('b', { class: 'nowrap', text: `${m.impact > 0 ? '+' : '−'}${dollars(Math.abs(m.impact))}` })))),
    h('div', { class: 'small muted', text: note })) : null);
  const moversSide = movers.ok ? [
    moverBox('Gone up in the last 90 days', movers.data.up, 'The dollar figure is what the rise cost on the last 90 days of buying.'),
    moverBox('Gone down', movers.data.down, 'What the drop saved, the same way.')] : [];

  let main, sideBoxes;
  if (!node) [main, sideBoxes] = menuNode(d, (dish) => go([{ kind: 'recipe', id: dish.id, name: dish.name, cost: dish.plateCost }]));
  else if (node.kind === 'recipe') [main, sideBoxes] = recipeNode(d, node, (line) => go([...trail, { kind: line.kind, id: line.id, name: line.name, amount: line.amount, unit: line.unit, cost: line.cost }]), go);
  else [main, sideBoxes] = productNode(d, node, go);
  show(shell(me, 'reports', [header, toolbar, page([crumbs, main].flat(), [search, ...sideBoxes, ...moversSide], { label: 'Prices' })]));
}

/** Search recipes and ingredients by name, as you type. */
function searchBox(pick) {
  const input = h('input', { type: 'search', placeholder: 'Flour, mozzarella, dough…', 'aria-label': 'Find an ingredient or recipe' });
  const out = h('div', { class: 'list compact search-hits' });
  let timer, asked = '';
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      asked = q;
      if (q.length < 2) return fill(out);
      const r = await costGet(`/api/costs/search?q=${encodeURIComponent(q)}`);
      if (asked !== q || !r.ok) return;
      const hits = [...r.data.products.map((p) => ({ ...p, kind: 'product' })), ...r.data.recipes.map((x) => ({ ...x, kind: 'recipe', recipeKind: x.kind }))];
      fill(out, hits.length ? hits.slice(0, 14).map((x) => h('button', { class: 'linkish lrow', onclick: () => pick({ kind: x.kind, id: x.id, name: x.name }) },
        h('span', { class: 'grow', text: x.name }),
        h('span', { class: 'small muted', text: x.kind === 'product' ? perUnitText(x.perUnit, x.unit) : x.recipeKind === 'prep' ? 'prep recipe' : 'recipe' }))) : h('div', { class: 'small muted', text: 'Nothing by that name.' }));
    }, 180);
  });
  return sideBox('Find an ingredient or recipe', input, out);
}

/** The top: every dish sold, by category, with what a plate costs. */
function menuNode(d, open) {
  const cats = new Map();
  for (const x of d.dishes) cats.set(x.category ?? 'Other', [...(cats.get(x.category ?? 'Other') ?? []), x]);
  const main = d.dishes.length ? [...cats].map(([cat, xs]) => h('section', { class: 'card' }, h('h2', { text: cat }),
    h('div', { class: 'rtable' }, h('div', { class: 'rrow head dishcost' }, ['Dish', 'Plate cost', 'Price', 'Food cost'].map((t, i) => h('div', { class: i ? 'num' : '', text: t }))),
      xs.sort((a, b) => b.plateCost - a.plateCost).map((x) => h('button', { class: 'rrow dishcost clickable', onclick: () => open(x) },
        h('div', { class: 'strong', text: x.name }),
        h('div', { class: 'num' }, h('span', { text: dollars(x.plateCost, { cents: true }) }), x.complete ? null : h('span', { class: 'small warn-text', title: 'Some ingredients have no price yet', text: ' *' })),
        h('div', { class: 'num', text: dollars(x.price, { cents: true }) }),
        h('div', { class: 'num', text: x.share !== undefined ? `${Math.round(x.share * 100)}%` : '–' }),
        h('div', { class: 'chev', 'aria-hidden': 'true', text: '›' }))))))
    : [h('section', { class: 'card' }, h('div', { class: 'small muted', text: 'No dishes with recipes have sold here yet.' }))];
  const incomplete = d.dishes.filter((x) => !x.complete).length;
  return [[h('div', { class: 'small muted', text: 'Click a dish to see what goes into it and what each part costs, down to the ingredients.' }), ...main],
    [incomplete ? sideBox('Missing prices', h('div', { class: 'small', text: `${incomplete} dish${incomplete === 1 ? ' has' : 'es have'} an ingredient with no price yet (marked *), so the plate cost is low.` })) : null]];
}

/** A recipe: what this much of it costs, and each line, biggest first. Lines with a recipe or ingredient behind them go down a step. */
function recipeNode(d, node, down, go) {
  const forWhat = d.asked ? `for ${unitAmount(d.asked.amount, d.asked.unit)}` : d.kind === 'dish' || d.price !== undefined ? 'a plate' : `a batch (${unitAmount(d.yield.amount, d.yield.unit)})`;
  const max = Math.max(...d.lines.map((l) => l.cost), 0.0001);
  const lines = h('div', { class: 'rtable' }, h('div', { class: 'rrow head costline' }, ['Goes in', 'Amount', 'Cost', 'Share'].map((t, i) => h('div', { class: i && i < 3 ? 'num' : '', text: t }))),
    d.lines.map((l) => {
      const can = l.kind === 'recipe' || l.kind === 'product';
      const bar = h('span', { class: 'hbar-track' }, h('span', { class: 'hbar-fill' }));
      bar.firstChild.style.width = `${(l.cost / max) * 100}%`;
      const cells = [h('div', { class: 'strong' }, l.name, l.kind === 'recipe' ? h('span', { class: 'small muted', text: ' · recipe' }) : null),
        h('div', { class: 'num small', text: unitAmount(l.amount, l.unit) }),
        h('div', { class: 'num' }, l.complete ? dollars(l.cost, { cents: true }) : h('span', { class: 'warn-text small', text: l.cost ? `${dollars(l.cost, { cents: true })} *` : 'no price' })),
        h('div', { class: 'row tight' }, bar, h('span', { class: 'small muted', text: `${Math.round(l.share * 100)}%` })),
        h('div', { class: 'chev', 'aria-hidden': 'true', text: can ? '›' : '' })];
      return can ? h('button', { class: 'rrow costline clickable', onclick: () => down(l) }, cells) : h('div', { class: 'rrow costline' }, cells);
    }));
  const main = [h('section', { class: 'card' },
    h('div', { class: 'row wrap' }, h('h2', { class: 'grow', text: d.name }), h('div', { class: 'big', text: dollars(d.total, { cents: true }) })),
    h('div', { class: 'small muted', text: `${forWhat[0].toUpperCase()}${forWhat.slice(1)}${d.asked && d.perBatch ? ` · ${dollars(d.perBatch, { cents: true })} for a whole batch of ${unitAmount(d.yield.amount, d.yield.unit)}` : ''}${d.complete ? '' : ' · * some ingredients have no price yet'}. Click a line to go down a step.` }),
    lines)];
  const donut = drillDonut({ title: forWhat, format: (v) => dollars(v, { cents: true }), items: d.lines.map((l) => ({ name: l.name, value: l.cost, ...(l.kind === 'recipe' || l.kind === 'product' ? { go: () => down(l) } : {}) })) });
  const sideBoxes = [
    d.price !== undefined ? statBox('Food cost', d.price ? `${Math.round((d.total / d.price) * 100)}%` : '–', h('div', { class: 'small muted', text: `${dollars(d.total, { cents: true })} of an average ${dollars(d.price, { cents: true })} paid · ${d.sold.toLocaleString()} sold lately` })) : null,
    donut ? sideBox('Where the cost goes', donut) : null,
    d.usedIn.length ? sideBox('Goes into', h('div', { class: 'list compact' }, d.usedIn.map((u) => h('button', { class: 'linkish lrow', onclick: () => go([{ kind: 'recipe', id: u.id, name: u.name }]) }, h('span', { class: 'grow', text: u.name }), h('span', { class: 'chev', text: '›' }))))) : null,
  ];
  return [main, sideBoxes];
}

/** An ingredient: what the step above uses of it, its price over time by vendor, and the dishes it's in. */
function productNode(d, node, go) {
  const hist = d.history;
  const vendors = hist.vendors.map((v) => v.vendor);
  // Colors go to vendors by who sold it first, so a vendor keeps its color when another arrives.
  const order = [...new Set(hist.points.map((p) => p.vendor ?? 'Unknown vendor'))];
  const colorOf = new Map(order.map((v, i) => [v, SERIES[i] ?? OTHER]));
  const main = [h('section', { class: 'card' },
    h('div', { class: 'row wrap' }, h('h2', { class: 'grow', text: d.name }),
      h('div', { class: 'big', text: d.total !== undefined ? dollars(d.total, { cents: true }) : perUnitText(d.perUnit, d.unit) })),
    h('div', { class: 'small muted', text: [d.asked ? `${unitAmount(d.asked.amount, d.asked.unit)} at ${perUnitText(d.perUnit, d.unit)}` : 'Today’s price, from the latest invoices', d.category].filter(Boolean).join(' · ') }),
    hist.points.length ? priceChart(hist, d.unit, colorOf) : h('div', { class: 'small muted', text: 'No invoices for this yet.' }),
    hist.switches.length ? h('div', { class: 'switches' }, h('div', { class: 'small muted strong', text: 'Vendor changes' }),
      hist.switches.slice(-8).reverse().map((sw) => h('div', { class: 'small' }, h('span', { class: 'muted', text: `${dateWithYear(sw.date)}: ` }),
        `${sw.from ?? 'Unknown'} → `, h('b', { text: sw.to ?? 'Unknown' })))) : null),
    d.dishes.length ? h('section', { class: 'card' }, h('h2', { text: 'The dishes it’s in' }),
      h('div', { class: 'rtable' }, h('div', { class: 'rrow head proddish' }, ['Dish', 'A plate uses', 'Costs', 'Of the plate', 'Sold'].map((t, i) => h('div', { class: i ? 'num' : '', text: t }))),
        d.dishes.map((x) => h('button', { class: 'rrow proddish clickable', onclick: () => go([{ kind: 'recipe', id: x.id, name: x.name }]) },
          h('div', { class: 'strong', text: x.name }), h('div', { class: 'num small', text: unitAmount(x.perPlate, x.unit) }),
          h('div', { class: 'num', text: dollars(x.costPerPlate, { cents: true }) }), h('div', { class: 'num', text: `${Math.round(x.share * 100)}%` }),
          h('div', { class: 'num', text: x.plates.toLocaleString() }), h('div', { class: 'chev', 'aria-hidden': 'true', text: '›' })))),
      d.tenPercent ? h('div', { class: 'small muted', text: `If it went up 10%, those plates would cost ${dollars(d.tenPercent, { cents: true })} more over the same stretch.` }) : null) : null];
  const sideBoxes = [
    statBox('Price now', perUnitText(hist.latest ?? d.perUnit, d.unit),
      h('div', { class: 'row tight' }, h('span', { class: `small ${changeClass(hist.change90)}`, text: changeText(hist.change90) }), h('span', { class: 'small muted', text: 'in 90 days' })),
      h('div', { class: 'row tight' }, h('span', { class: `small ${changeClass(hist.change365)}`, text: changeText(hist.change365) }), h('span', { class: 'small muted', text: 'in a year' }))),
    vendors.length ? sideBox('Vendors', h('div', { class: 'list compact' }, hist.vendors.map((v) => {
      const key = h('span', { class: 'lkey' }); key.style.background = colorOf.get(v.vendor) ?? OTHER; key.style.borderColor = colorOf.get(v.vendor) ?? OTHER;
      return h('div', {}, key, h('span', { class: 'grow' }, h('div', { text: v.vendor }), h('div', { class: 'small muted', text: `${v.purchases} invoice${v.purchases === 1 ? '' : 's'} · last ${shortDate(v.last)}` })), h('b', { text: dollars(v.spent) }));
    }))) : null,
    d.usedIn.length ? sideBox('Recipes that use it', h('div', { class: 'list compact' }, d.usedIn.map((u) => h('button', { class: 'linkish lrow', onclick: () => go([{ kind: 'recipe', id: u.id, name: u.name }]) }, h('span', { class: 'grow', text: u.name }), h('span', { class: 'chev', text: '›' }))))) : null,
  ];
  return [main, sideBoxes];
}

/** Price per unit over time: a dot per purchase in its vendor's color, and a strip below showing who supplied it when. */
function priceChart(hist, unit, colorOf) {
  const pts = hist.points;
  const W = 760, H = 250, L = 64, R = 16, T = 14, B = 46;
  const t = (p) => Date.parse(`${p.date}T12:00:00Z`);
  const t0 = t(pts[0]), t1 = Math.max(t(pts[pts.length - 1]), t0 + 86_400_000 * 14);
  const vals = pts.map((p) => p.perUnit).sort((a, b) => a - b);
  // Ignore a stray price far off the rest (a pack logged in the wrong unit) when setting the scale.
  const lo = vals[Math.floor(vals.length * 0.02)], hi = vals[Math.ceil(vals.length * 0.98) - 1];
  const pad = Math.max((hi - lo) * 0.15, hi * 0.05);
  const yMin = Math.max(0, lo - pad), yMax = hi + pad;
  const x = (p) => L + ((t(p) - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (Math.min(Math.max(v, yMin), yMax) - yMin) / (yMax - yMin)) * (H - T - B);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': `Price per ${unit} from ${shortDate(pts[0].date)} to ${shortDate(pts[pts.length - 1].date)}` });
  for (let k = 0; k <= 4; k++) {
    const v = yMin + ((yMax - yMin) / 4) * k;
    svg.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: k ? 'grid' : 'axis' }), s('text', { x: L - 8, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }, document.createTextNode(perUnitText(v))));
  }
  // Month ticks.
  const months = [];
  for (let m = new Date(t0); m.getTime() <= t1; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) months.push(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
  const every = Math.max(1, Math.ceil(months.length / 8));
  months.filter((m, i) => m <= t1 && i % every === 0).forEach((m) => {
    const mx = L + ((m - t0) / (t1 - t0)) * (W - L - R);
    const dd = new Date(m);
    svg.append(s('text', { x: mx, y: H - B + 16, class: 'tick', 'text-anchor': 'middle' }, document.createTextNode(dd.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }) + (dd.getUTCMonth() === 0 ? ` ${dd.getUTCFullYear()}` : ''))));
  });
  svg.append(s('polyline', { points: pts.map((p) => `${x(p).toFixed(1)},${y(p.perUnit).toFixed(1)}`).join(' '), fill: 'none', stroke: OTHER, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
  // Who supplied it when: a band per stretch with one vendor.
  const stripY = H - B + 26, stripH = 10;
  let start = 0;
  for (let i = 1; i <= pts.length; i++) {
    if (i < pts.length && (pts[i].vendor ?? '') === (pts[start].vendor ?? '')) continue;
    const x0 = x(pts[start]), x1 = i < pts.length ? x(pts[i]) : W - R;
    svg.append(s('rect', { x: x0, y: stripY, width: Math.max(2, x1 - x0 - 1), height: stripH, fill: colorOf.get(pts[start].vendor ?? 'Unknown vendor') ?? OTHER }));
    if (i < pts.length && hist.switches.length <= 6) svg.append(s('line', { x1: x1, x2: x1, y1: T, y2: stripY + stripH, class: 'switch-line' }));
    start = i;
  }
  for (const p of pts) svg.append(s('circle', { cx: x(p), cy: y(p.perUnit), r: 4, fill: colorOf.get(p.vendor ?? 'Unknown vendor') ?? OTHER, stroke: '#fff', 'stroke-width': 1.5 }));
  const ring = s('circle', { r: 7, fill: 'none', stroke: '#000', 'stroke-width': 1.5, visibility: 'hidden' });
  svg.append(ring);
  const wrap = h('div', { class: 'chart' }, svg);
  const tip = tooltipBox(wrap);
  let at = pts.length - 1;
  const showAt = (i) => {
    const p = pts[i];
    ring.setAttribute('cx', x(p)); ring.setAttribute('cy', y(p.perUnit)); ring.setAttribute('visibility', 'visible');
    const box = svg.getBoundingClientRect(), wb = wrap.getBoundingClientRect();
    tip.show((x(p) / W) * box.width + box.left - wb.left, (y(p.perUnit) / H) * box.height, new Date(`${p.date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
      [[colorOf.get(p.vendor ?? 'Unknown vendor'), perUnitText(p.perUnit, unit), p.vendor ?? 'Unknown vendor'], [null, dollars(p.packPrice, { cents: true }), `for ${p.pack}${p.quantity !== 1 ? ` · bought ${qty(p.quantity)}` : ''}`]]);
  };
  const hide = () => { ring.setAttribute('visibility', 'hidden'); tip.hide(); };
  const hit = s('rect', { x: L, y: T, width: W - L - R, height: H - T - B + 40, fill: 'transparent', tabindex: 0, 'aria-label': 'Prices paid: use the arrow keys' });
  hit.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect(), px = ((e.clientX - box.left) / box.width) * W;
    let best = 0; pts.forEach((p, i) => { if (Math.abs(x(p) - px) < Math.abs(x(pts[best]) - px)) best = i; });
    showAt((at = best));
  });
  hit.addEventListener('pointerleave', hide); hit.addEventListener('blur', hide);
  hit.addEventListener('focus', () => showAt(at));
  hit.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') showAt((at = Math.max(0, at - 1))); if (e.key === 'ArrowRight') showAt((at = Math.min(pts.length - 1, at + 1))); });
  svg.append(hit);
  const key = legend([...colorOf].map(([name, color]) => ({ name, color, on: true, fixed: true })));
  return h('div', {}, key, wrap, h('div', { class: 'small muted', text: `Each dot is an invoice, per ${unit} so packs of different sizes compare; its color is the vendor. The strip underneath shows who it came from when${hist.switches.length <= 6 ? ', with a line at each change' : ''}.` }));
}

// ------------------------------------------------------------------ orders

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const clock12 = (t) => { if (!t) return ''; const [hh, mm] = t.split(':').map(Number); return `${((hh + 11) % 12) + 1}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${hh < 12 ? 'am' : 'pm'}`; };
const dueText = (d, today) => !d ? 'No order cutoff set' : `Due ${d.date === today ? 'today' : weekdayName(d.date)} by ${clock12(d.time)}`;
const STATUS_TAG = { draft: ['Draft', 'warn'], approved: ['Approved, not sent', 'blue'], sent: ['Sent', 'ok'] };

async function ordersScreen(me) {
  loadingScreen(me, 'orders', 'Orders');
  const side = sideOf(me);
  const r = await api('GET', `/api/orders?area=${side}`);
  if (!r.ok) return show(shell(me, 'orders', [h('h1', { text: 'Orders' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const { vendors, recent, today } = r.data;
  const active = vendors.filter((v) => v.active), paused = vendors.filter((v) => !v.active);
  const vendorCard = (v) => {
    const [tag, cls] = v.order ? STATUS_TAG[v.order.status] : ['Not started', ''];
    return h('section', { class: 'card' },
      h('div', { class: 'vendor-row' },
        h('div', {}, h('div', { class: 'row tight wrap' }, h('h2', { text: v.name }), h('span', { class: `tag ${cls}`, text: tag })),
          h('div', { class: 'small muted', text: `Delivers ${v.weekdays.map((d) => WD[d]).join(', ')}${v.source === 'confirmed' ? '' : ' (from invoices)'} · about ${dollars(v.spendPerWeek)} a week` })),
        h('div', { class: 'row tight' },
          h('div', { class: 'when' }, h('div', { class: 'strong', text: v.next ? `${weekdayName(v.next)}, ${shortDate(v.next)}` : 'No delivery coming up' }),
            h('div', { class: `small${v.deadline && v.deadline.date <= today ? ' warn-text' : ' muted'}`, text: v.order?.total ? `${dollars(v.order.total)} · ${dueText(v.deadline, today).toLowerCase()}` : dueText(v.deadline, today) })),
          v.next ? h('button', { class: `btn${v.order ? '' : ' dark'}`, text: v.order ? 'Open' : 'Start order', onclick: () => orderScreen(me, v.vendorId) }) : null)));
  };
  const drafts = active.filter((v) => v.order?.status === 'draft').length;
  const unsent = active.filter((v) => v.order?.status === 'approved').length;
  const week = statBox(`${AREA_NAMES[side]} · usual spend`, `${dollars(active.reduce((a, v) => a + (v.spendPerWeek ?? 0), 0))} a week`,
    h('div', { class: 'small muted', text: `From ${active.length} vendor${active.length === 1 ? '' : 's'} with regular deliveries, by their invoices.` }));
  const status = sideBox('Orders in progress', h('div', { class: 'list compact' },
    h('div', {}, h('span', { class: 'grow', text: 'Drafts to approve' }), h('b', { text: String(drafts) })),
    h('div', {}, h('span', { class: 'grow', text: 'Approved, not sent' }), h('b', { text: String(unsent) }))),
    h('div', { class: 'small muted', text: 'A manager approves each order; nothing goes out by itself.' }));
  const noCutoff = active.filter((v) => !v.deadline).length;
  const cutoffs = noCutoff ? sideBox('Order cutoffs', h('div', { class: 'small muted', text: `${noCutoff} vendor${noCutoff === 1 ? ' has' : 's have'} no cutoff yet. Open a vendor and set it under Vendor settings, and Today reminds whoever orders before it’s due.` })) : null;
  const recentBox = recent.length ? sideBox('Recent orders', h('div', { class: 'picks' }, recent.map((o) => h('button', { class: 'pick', onclick: () => orderScreen(me, o.vendorId, o.delivery) },
    h('span', { class: 'grow' }, h('div', { text: o.vendorName }), h('div', { class: 'small muted', text: `${o.status === 'sent' ? 'Sent' : 'Approved'} · for ${WD[new Date(`${o.delivery}T12:00:00`).getDay()]} ${shortDate(o.delivery)}` })),
    o.total ? h('span', { class: 'small', text: dollars(o.total) }) : null)))) : null;
  const pausedBox = paused.length ? sideBox('Not ordering from', h('div', { class: 'small', text: paused.map((v) => v.name).join(' · ') })) : null;
  show(shell(me, 'orders', [
    h('header', { class: 'row wrap' },
      h('div', { class: 'grow' }, h('div', { class: 'kicker', text: `${AREA_NAMES[side]} · ${dayName(today)}` }), h('h1', { text: 'Orders' }),
        h('div', { class: 'sub', text: 'Drafted from what you’ve been buying, weighted to your busy days, less what’s on hand. Next delivery first.' })),
      sideSwitch(me, () => ordersScreen(me))),
    page(active.length ? h('div', { class: 'stack' }, active.map(vendorCard)) : h('div', { class: 'card small muted', text: 'No vendors with regular deliveries yet. They appear after a few weeks of invoices.' }),
      [week, status, spendBox(me, side), cutoffs, recentBox, pausedBox]),
  ]));
}

/** Where the money went, last 30 days: each vendor, then what was bought from them; an item opens its prices. Fills in after the page is up. */
function spendBox(me, side) {
  const box = sideBox('Spent, last 30 days', h('div', { class: 'small muted', text: 'Loading…' }));
  api('GET', `/api/costs/spend?area=${side}&days=30`).then((r) => {
    if (!r.ok || !r.data.vendors.length) return box.remove();
    const dn = drillDonut({ title: 'spent', crumb: 'Vendors', format: dollars, items: r.data.vendors.map((v) => ({ name: v.vendor, value: v.spent,
      open: () => ({ title: 'spent', items: v.items.map((i) => ({ name: i.name, value: i.spent, ...(i.id ? { go: () => reportsScreen(me, { report: 'prices', trail: [{ kind: 'product', id: i.id, name: i.name }] }) } : {}) })) }) })) });
    fill(box, h('div', { class: 'small muted strong', text: 'Spent, last 30 days' }), dn, h('div', { class: 'small muted', text: 'From the invoices. Click a vendor for what you bought from them, and an item for its price over time.' }));
  });
  return box;
}

/** One vendor's order for one delivery: lines to review, then approve, then send. */
async function orderScreen(me, vendorId, delivery) {
  loadingScreen(me, 'orders', 'Order');
  const r = await api('GET', `/api/orders/vendor/${encodeURIComponent(vendorId)}${delivery ? `?delivery=${delivery}` : ''}`);
  if (!r.ok) return show(shell(me, 'orders', [h('h1', { text: 'Order' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' }), h('button', { class: 'btn', text: '← Orders', onclick: () => ordersScreen(me) })]));
  const d = r.data;
  const v = d.vendor;
  const order = d.order;
  const status = order?.status ?? 'new';
  const editable = status === 'new' || status === 'draft';
  // Lines: the saved order's, then everything else the vendor sells you, suggestions first.
  const saved = new Map((order?.lines ?? []).map((l) => [l.productId, l]));
  const lines = d.draft.map((l) => { const s = saved.get(l.productId); return { ...l, packs: s ? s.packs : status === 'new' ? l.suggested : 0, onHandInput: s?.onHand !== undefined && !s.onHandEstimated ? s.onHand : '' }; });
  const err = h('div', { class: 'error', role: 'alert' });
  const totalBox = h('div', { class: 'order-total' });
  const drawTotal = () => {
    const on = lines.filter((l) => l.packs > 0);
    const total = on.reduce((s, l) => s + l.packs * (l.packPrice ?? 0), 0);
    fill(totalBox, h('div', { class: 'grow' }, h('div', { class: 'big', text: dollars(total, { exact: true }) }), h('div', { class: `small${v.minimum && total < v.minimum ? ' warn-text' : ' muted'}`, text: `${on.length} item${on.length === 1 ? '' : 's'}${v.minimum && total < v.minimum ? ` · below the ${dollars(v.minimum)} minimum` : ''}` })));
  };
  const lineRow = (l) => {
    const cost = h('div', { class: 'num', text: l.packs ? dollars(l.packs * l.packPrice, { cents: true }) : '' });
    const packs = editable ? stepper(l.packs, 1, (val) => { l.packs = Math.max(0, Math.round(Number(val) || 0)); cost.textContent = l.packs ? dollars(l.packs * l.packPrice, { cents: true }) : ''; drawTotal(); }, `Packs of ${l.name}`) : h('div', { class: 'strong', text: `${l.packs}` });
    const onHand = editable ? h('input', { inputmode: 'decimal', class: 'short', value: l.onHandInput === '' ? '' : String(l.onHandInput), placeholder: qty(l.onHand), 'aria-label': `On hand, ${l.name}`, title: 'What you counted. Blank uses the estimate.' }) : null;
    onHand?.addEventListener('change', () => { l.onHandInput = onHand.value.trim() === '' ? '' : Number(onHand.value); });
    return h('div', { class: `orow${l.packs ? '' : ' zero'}` },
      h('div', {}, h('div', { class: 'strong', text: l.name }), h('div', { class: 'small muted', text: l.reason })),
      h('div', { class: 'small', text: `${l.packLabel} · ${dollars(l.packPrice, { cents: true })}` }),
      onHand ? h('div', { class: 'row tight' }, onHand, h('span', { class: 'small muted', text: l.unit })) : h('div', { class: 'small muted', text: l.onHandInput !== '' ? `${qty(l.onHandInput)} ${l.unit} counted` : '' }),
      h('div', { class: 'order-cell' }, packs, l.suggested && l.suggested !== l.packs ? h('span', { class: 'small muted', text: `suggested ${l.suggested}` }) : null),
      cost);
  };
  const body = () => ({ delivery: d.delivery, lines: lines.filter((l) => l.packs > 0 || l.onHandInput !== '').map((l) => ({ productId: l.productId, packs: l.packs, suggested: l.suggested, ...(l.onHandInput !== '' ? { onHand: l.onHandInput } : {}) })) });
  const save = async () => { const res = await api('POST', `/api/orders/vendor/${encodeURIComponent(vendorId)}`, body()); if (!res.ok) { err.textContent = res.data.error ?? 'Not saved.'; return null; } return res.data.order; };
  const act = async (action, id) => { const res = await api('POST', `/api/orders/${id}/${action}`); if (!res.ok) { err.textContent = res.data.error ?? 'That didn’t work.'; return false; } return true; };

  const suggestedLines = lines.filter((l) => l.packs > 0 || l.suggested > 0);
  const otherLines = lines.filter((l) => !(l.packs > 0 || l.suggested > 0));
  const others = h('details', { class: 'others' }, h('summary', { text: `Everything else from ${v.name} (${otherLines.length})` }), h('div', { class: 'olist' }, otherLines.map(lineRow)));
  const head = h('div', { class: 'orow head' }, h('div', { text: 'Product' }), h('div', { text: 'Pack' }), h('div', { text: editable ? 'On hand' : '' }), h('div', { text: 'Order' }), h('div', { class: 'num', text: 'Cost' }));

  // Approved: the order as it goes out, and how to send it.
  let sendBox = null;
  if (order && (status === 'approved' || status === 'sent')) {
    const items = order.lines.filter((l) => l.packs > 0);
    const subject = `${d.restaurant} order for ${weekdayName(d.delivery)} ${shortDate(d.delivery)}`;
    const text = [`Hi,`, ``, `${d.restaurant} order for delivery ${weekdayName(d.delivery)}, ${shortDate(d.delivery)}:`, ``, ...items.map((l) => `${l.packs} × ${l.packLabel}  ${l.name}`), ``, `Thank you!`].join('\n');
    const copy = h('button', { class: 'btn', text: 'Copy order', onclick: async () => { try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; } catch { pre.focus(); } } });
    const email = v.contact && v.contact.includes('@') ? h('a', { class: 'btn', href: `mailto:${encodeURIComponent(v.contact)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`, text: 'Email it' }) : null;
    const textMsg = v.contact && /\d{3}.*\d{4}/.test(v.contact) && v.method === 'text' ? h('a', { class: 'btn', href: `sms:${v.contact.replace(/[^\d+]/g, '')}?&body=${encodeURIComponent(text)}`, text: 'Text it' }) : null;
    const pre = h('pre', { class: 'order-text', tabindex: '0', text });
    sendBox = h('section', { class: 'card' },
      h('div', { class: 'row wrap' }, h('h2', { class: 'grow', text: status === 'sent' ? `Sent ${when(order.sentAt)} by ${order.sentBy ?? ''}` : `Approved by ${order.approvedBy ?? ''}: ready to send` }),
        status === 'approved' ? h('button', { class: 'link', text: 'Reopen to change', onclick: async () => { if (await act('reopen', order.id)) orderScreen(me, vendorId, d.delivery); } }) : null),
      h('div', { class: 'small muted', text: v.method ? `${v.name} takes orders by ${v.method}${v.contact ? `: ${v.contact}` : ''}.` : 'Add how this vendor takes orders under Vendor settings.' }),
      pre,
      h('div', { class: 'row wrap' }, email, textMsg, copy, h('button', { class: 'btn', text: 'Print', onclick: () => window.print() }),
        status === 'approved' ? h('button', { class: 'btn dark', text: 'Mark as sent', onclick: async () => { if (await act('sent', order.id)) orderScreen(me, vendorId, d.delivery); } }) : null));
  }

  const settingsBox = vendorSettings(me, d, () => orderScreen(me, vendorId, d.delivery));
  const [tag, cls] = STATUS_TAG[status] ?? ['New', ''];
  drawTotal();
  // The order's total and what to do with it sit on the right, beside the lines.
  const totalSide = h('section', { class: 'card tight order-side' },
    h('div', { class: 'row' }, h('div', { class: 'grow small muted strong', text: editable ? 'This order' : 'Ordered' }), h('span', { class: `tag ${cls}`, text: tag })),
    totalBox, err,
    sideActions(
      editable ? h('button', { class: 'btn dark', text: 'Approve order', onclick: async () => { const o = await save(); if (o && await act('approve', o.id)) orderScreen(me, vendorId, d.delivery); } }) : null,
      editable ? h('button', { class: 'btn', text: 'Save draft', onclick: async () => { if (await save()) orderScreen(me, vendorId, d.delivery); } }) : null,
      editable ? h('button', { class: 'btn', text: 'Update suggestions', title: 'Saves the counts and works the suggestions out again', onclick: async () => { if (await save()) orderScreen(me, vendorId, d.delivery); } }) : null,
      order && status !== 'sent' ? h('button', { class: 'link danger', text: 'Cancel order', onclick: async () => { if (confirmText('Cancel this order?') && await act('cancel', order.id)) ordersScreen(me); } }) : null),
    editable ? h('div', { class: 'small muted', text: 'Nothing goes to the vendor until it’s approved and you send it.' }) : null);
  const whenBox = sideBox('Delivery', h('div', { class: 'row wrap' }, d.upcoming.map((x) => h('button', { class: `btn small-btn${x === d.delivery ? ' dark' : ''}`, text: `${WD[new Date(`${x}T12:00:00`).getDay()]} ${shortDate(x)}`, onclick: () => orderScreen(me, vendorId, x) }))),
    h('div', { class: 'small muted', text: `Covers use until ${weekdayName(d.following)}’s delivery.` }));
  show(shell(me, 'orders', [
    h('header', { class: 'row wrap' },
      h('div', { class: 'grow' }, h('div', { class: 'kicker', text: `Order · ${v.name}` }), h('h1', { text: `${weekdayName(d.delivery)}, ${shortDate(d.delivery)}` }),
        h('div', { class: 'sub', text: dueText(d.deadline, d.today) })),
      h('button', { class: 'btn', text: '← Orders', onclick: () => ordersScreen(me) })),
    page([
      sendBox,
      h('section', { class: 'card' },
        h('h2', { text: editable ? 'To order' : 'Ordered' }),
        editable ? h('div', { class: 'small muted', text: 'Count what’s on hand to sharpen the suggestions; blank uses the estimate from recent deliveries.' }) : null,
        h('div', { class: 'olist' }, head, (editable ? suggestedLines : lines.filter((l) => l.packs > 0)).map(lineRow)),
        editable && otherLines.length ? others : null),
    ], [totalSide, whenBox, settingsBox]),
  ]));
}

/** Delivery days (learned, confirmed here), when orders are due, how they're sent. */
function vendorSettings(me, d, done) {
  const v = d.vendor;
  const days = new Set(v.weekdays);
  const err = h('span', { class: 'error' });
  const dayButtons = h('div', { class: 'seg' }, WD.map((w, i) => { const b = h('button', { class: days.has(i) ? 'on' : '', text: w, 'aria-pressed': String(days.has(i)), onclick: () => { days.has(i) ? days.delete(i) : days.add(i); b.classList.toggle('on'); } }); return b; }));
  const before = h('select', { 'aria-label': 'Days before delivery' }, h('option', { value: '', text: 'No cutoff' }), [0, 1, 2, 3].map((n) => h('option', { value: String(n), text: n === 0 ? 'Same day' : n === 1 ? 'Day before' : `${n} days before`, selected: v.cutoff?.daysBefore === n ? true : undefined })));
  const time = h('input', { type: 'time', value: v.cutoff?.time ?? '14:00', 'aria-label': 'Order by' });
  const method = h('select', { 'aria-label': 'How orders are sent' }, h('option', { value: '', text: 'How they take orders…' }), ['email', 'text', 'phone', 'portal', 'rep', 'in person'].map((m) => h('option', { value: m, text: m[0].toUpperCase() + m.slice(1), selected: v.method === m ? true : undefined })));
  const contact = h('input', { type: 'text', value: v.contact ?? '', placeholder: 'Email, phone or rep name', 'aria-label': 'Contact' });
  const minimum = h('input', { inputmode: 'decimal', class: 'short', value: v.minimum ?? '', placeholder: '$', 'aria-label': 'Order minimum' });
  const active = h('input', { type: 'checkbox', checked: v.active ? true : undefined, 'aria-label': 'Order from this vendor' });
  return h('details', { class: 'card settings' }, h('summary', {}, h('span', { class: 'strong', text: 'Vendor settings' }), h('span', { class: 'small muted', text: ` · learned from invoices: delivers ${v.learned.map((x) => WD[x]).join(', ') || '—'}` })),
    h('div', { class: 'stack' },
      h('div', { class: 'row wrap' }, h('span', { class: 'small strong', text: 'Delivers' }), dayButtons),
      h('div', { class: 'row wrap' }, h('span', { class: 'small strong', text: 'Order due' }), before, h('span', { class: 'small muted', text: 'by' }), time),
      h('div', { class: 'row wrap' }, method, h('div', { class: 'grow' }, contact), h('span', { class: 'small strong', text: 'Minimum' }), minimum),
      h('label', { class: 'inline' }, active, 'Order from this vendor'),
      h('div', { class: 'row' }, h('button', { class: 'btn dark', text: 'Save settings', onclick: async () => {
        const res = await api('POST', `/api/orders/vendor/${encodeURIComponent(v.vendorId)}/settings`, { weekdays: [...days], cutoffDaysBefore: before.value === '' ? null : Number(before.value), cutoffTime: time.value, method: method.value || null, contact: contact.value, minimum: minimum.value, active: active.checked });
        if (!res.ok) return (err.textContent = res.data.error ?? 'Not saved.');
        done();
      } }), err)));
}

// ------------------------------------------------------------------ recipe coverage

/** One bar, three parts: sales with a full plate cost, with a card missing a price, with no card. */
function coverageBar(c, big = false) {
  const total = c.complete + c.gaps + c.noCard;
  const parts = [['complete', c.complete, 'Fully costed'], ['gaps', c.gaps, 'Recipe missing a price'], ['nocard', c.noCard, 'No recipe yet']];
  const bar = h('div', { class: `cov-bar${big ? ' big' : ''}`, role: 'img', 'aria-label': parts.map(([, v, l]) => `${l} ${total ? Math.round((v / total) * 100) : 0}%`).join(', ') },
    parts.map(([k, v]) => { const seg = h('div', { class: `cov-${k}` }); seg.style.width = `${total ? (v / total) * 100 : 0}%`; return seg; }));
  const legend = h('div', { class: 'cov-legend' }, parts.map(([k, v, l]) => h('div', {}, h('span', { class: `cov-key cov-${k}` }), h('span', { class: 'grow', text: l }), h('b', { text: `${total ? Math.round((v / total) * 100) : 0}%` }), big ? h('span', { class: 'small muted', text: dollars(v) }) : null)));
  return [bar, legend];
}

function coverageCard(me, c, side) {
  const total = c.complete + c.gaps + c.noCard;
  if (!total) return null;
  return h('button', { class: 'card tight cov-card', onclick: () => { if (side !== 'all') me.side = side; coverageScreen(me); }, 'aria-label': 'Recipe coverage: see what’s missing' },
    h('div', { class: 'small muted strong', text: `Menu with full costs, last 90 days${side === 'all' ? '' : ` · ${AREA_NAMES[side]}`}` }),
    coverageBar(c),
    h('div', { class: 'small muted', text: [c.gapCount ? `${c.gapCount} price${c.gapCount === 1 ? '' : 's'} to fill in` : '', c.noCardCount ? `${c.noCardCount} item${c.noCardCount === 1 ? '' : 's'} without a recipe` : ''].filter(Boolean).join(' · ') || 'Everything is costed.' }));
}

/** What keeps the menu from being fully costed: prices and conversions to fill in, cards to write. */
async function coverageScreen(me) {
  loadingScreen(me, 'today', 'Recipe coverage');
  const side = sideOf(me);
  const [m, cards] = await Promise.all([api('GET', `/api/margins?area=${side}`), api('GET', `/api/cards?area=${side}`)]);
  if (!m.ok) return show(shell(me, 'today', [h('h1', { text: 'Recipe coverage' }), h('div', { class: 'error', text: m.data.error ?? 'Couldn’t load.' })]));
  const c = m.data.coverage;
  const noCard = (cards.data.noCard ?? []).slice(0, 60);
  const noCardBox = noCard.length ? h('section', { class: 'card', id: 'cov-nocard' },
    h('div', { class: 'row' }, h('h2', { class: 'grow', text: `Selling without a recipe (${cards.data.noCard.length})` }),
      side === 'bar' ? h('button', { class: 'btn dark', text: 'Draft bar recipes', onclick: () => draftsScreen(me) }) : null),
    h('div', { class: 'small muted', text: 'Their sales aren’t counted in food cost until they have a recipe. Biggest sellers first.' }),
    h('div', { class: 'list' }, noCard.map((x) => h('div', {},
      h('div', { class: 'grow' }, h('div', { text: x.name }), h('div', { class: 'small muted', text: `${x.category} · ${x.sold} sold · ${dollars(x.netSales)} in 90 days` })),
      h('button', { class: 'btn small-btn', text: 'Write recipe', onclick: () => cardEditor(me, cards.data, null, { name: x.itemName, kind: side === 'bar' ? 'drink' : 'dish', link: [x] }) }),
      h('button', { class: 'link', text: 'No recipe needed', onclick: async () => { await api('POST', '/api/cards/no-card', { items: [x] }); coverageScreen(me); } }))))) : null;
  show(shell(me, 'today', [
    h('header', { class: 'row wrap' },
      h('div', { class: 'grow' }, h('div', { class: 'kicker', text: `${AREA_NAMES[side]} · last 90 days of sales` }), h('h1', { text: 'Recipe coverage' }),
        h('div', { class: 'sub', text: 'How much of what you sell has a full plate cost behind it. Fill in the missing prices and write the missing recipes, and food cost covers the whole menu.' })),
      h('div', { class: 'row wrap' }, h('button', { class: 'btn', text: '← Today', onclick: () => todayScreen(me) }), sideSwitch(me, () => coverageScreen(me)))),
    page([
      gapsCard(me, m.data.gaps, () => coverageScreen(me)) ?? h('div', { class: 'card small muted', text: 'Every recipe prices out completely.' }),
      noCardBox,
    ], [
      sideBox('Sales, last 90 days', coverageBar(c, true)),
      sideBox('What to do', h('ol', { class: 'steps' },
        c.gapCount ? h('li', { text: `Answer the ${c.gapCount} price question${c.gapCount === 1 ? '' : 's'}: one answer fixes every dish that uses it.` }) : null,
        c.noCardCount ? h('li', {}, 'Write a recipe for what sells without one, biggest first ', h('button', { class: 'linkish', text: '(the list)', onclick: () => document.getElementById('cov-nocard')?.scrollIntoView({ behavior: 'smooth' }) }), '.') : null,
        h('li', { text: 'Things that aren’t food or drink (fees, gift cards) can be marked No recipe needed.' }))),
      sideBox('Recipes', sideActions(h('button', { class: 'btn small-btn', text: 'Recipe costs', onclick: () => cardsScreen(me) }))),
    ]),
  ]));
}

// ------------------------------------------------------------------ settings

async function home(me) {
  const manager = atLeast(me.roleLevel, 'manager');
  const signOut = h('button', { class: 'btn', onclick: async () => { await api('POST', '/api/logout'); start(); }, text: 'Sign out' });
  const header = h('header', { class: 'row' },
    h('div', { class: 'grow' }, h('div', { class: 'kicker', text: me.restaurantName ?? '' }), h('h1', { text: 'Settings' }),
      h('div', { class: 'sub', text: manager ? 'Your team, kitchen iPads and how the menu is split, in the middle; connections and your own sign-in on the right.' : 'Your prep list will show up here once your station is set up.' })));
  const you = sideBox('Signed in', h('div', { class: 'strong', text: me.name }), h('div', { class: 'small muted', text: `${ACCESS_NAMES[me.access] ?? me.access}${me.area ? ` · ${AREA_NAMES[me.area] ?? me.area}` : ''}` }), sideActions(signOut));
  const main = manager ? [await teamCard(me), await areasCard(), await deviceCard(), await importCard(), await prepImportCard()] : [h('div', { class: 'card small muted', text: 'Nothing to set up here yet.' })];
  const side = [you, manager ? await syncCard('square') : null, manager ? await syncCard('marginedge') : null, ownPinCard(me), canAdminister(me) ? brandCard(me) : null];
  show(shell(me, 'settings', [header, page(main, side)]));
}

const SOURCES = {
  square: { name: 'Square', secret: 'SQUARE_ACCESS_TOKEN', what: 'sales, menu and team', summary: (d) => `sales ${shortDate(d.from)} – ${shortDate(d.to)}, ${d.itemRows} item rows, ${d.modifierRows} modifier rows, ${d.catalogObjects} catalog entries${d.orders !== undefined ? `, ${d.orders} orders from ${shortDate(d.ordersFrom)}` : ''}. Team: ${d.team?.added ?? 0} added, ${d.team?.updated ?? 0} updated, ${d.team?.deactivated ?? 0} no longer active.` },
  marginedge: { name: 'MarginEdge', secret: 'MARGINEDGE_API_KEY', what: 'invoices, products and pack sizes', summary: (d) => `${d.invoices} invoices since ${shortDate(d.from)}, ${d.products} products, ${d.vendorItems} vendor items.` },
};

async function syncCard(source) {
  const info = SOURCES[source];
  const box = h('section', { class: 'card', 'aria-label': info.name });
  const draw = async (extra) => {
    const r = await api('GET', '/api/sync');
    const connected = r.data.connected?.[source];
    const last = (r.data.runs ?? []).find((x) => x.source === source);
    const status = !connected ? h('span', { class: 'tag warn', text: 'Not connected' })
      : !last ? h('span', { class: 'tag', text: 'Not synced yet' })
      : last.status === 'ok' ? h('span', { class: 'tag ok', text: 'Synced' })
      : last.status === 'running' ? h('span', { class: 'tag warn', text: 'Syncing…' })
      : h('span', { class: 'tag bad', text: 'Last sync failed' });
    const detail = last?.detail ?? {};
    const lines = [];
    if (!connected) lines.push(h('div', { class: 'small muted', text: `Add ${info.secret} in Render (web service → Environment). The app only reads from ${info.name}.` }));
    if (last?.status === 'ok') lines.push(h('div', { class: 'small', text: `${when(last.finished_at)}: ${info.summary(detail)}` }));
    if (last?.status === 'running') {
      if (detail.progress) lines.push(h('div', { class: 'small', text: `Working on: ${detail.progress}` }));
      lines.push(h('div', { class: 'small muted', text: source === 'marginedge' ? 'The first MarginEdge sync reads 6 months of invoices one by one and can take 30 minutes or more. Later ones take a minute or two.' : 'This can take a minute or two.' }));
      setTimeout(draw, 5000);
    }
    if (last?.status === 'failed') lines.push(h('div', { class: 'error', text: detail.error ?? 'Unknown error' }));
    if (extra) lines.push(extra);
    const button = h('button', { class: 'btn dark', disabled: !connected || last?.status === 'running', text: 'Sync now', onclick: async () => {
        button.disabled = true;
        const s = await api('POST', `/api/sync/${source}`);
        setTimeout(() => draw(s.ok ? null : h('div', { class: 'error', text: s.data.error })), 1200);
      } });
    fill(box, 
      h('div', { class: 'row' }, h('h2', { class: 'grow', text: info.name }), status),
      h('div', { class: 'small muted', text: `Brings in ${info.what}. Syncs by itself every night after 4 am.` }),
      ...lines,
      h('div', {}, button),
    );
  };
  await draw();
  return box;
}

// Recipe cards and earlier answers, from a kitchen-book file.
async function importCard() {
  const box = h('section', { class: 'card', 'aria-label': 'Recipes and answers' });
  const NAMES = { recipeCards: 'Recipes', importAnswers: 'Product answers (merges, pack sizes, prices)', linkAnswers: 'Dish links and seasonal versions', modifierAnswers: 'Modifier answers' };
  const draw = async (message) => {
    const r = await api('GET', '/api/book');
    const parts = r.data.parts ?? [];
    const err = h('div', { class: 'error' });
    const input = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Kitchen-book file' });
    const button = h('button', { class: 'btn dark', text: 'Import', onclick: async () => {
        const file = input.files?.[0];
        if (!file) return (err.textContent = 'Choose the file first.');
        let data;
        try { data = JSON.parse(await file.text()); } catch { return (err.textContent = 'That file isn’t readable JSON.'); }
        button.disabled = true;
        const res = await api('POST', '/api/book/import', data);
        button.disabled = false;
        if (!res.ok) return (err.textContent = res.data.error ?? 'Import failed.');
        draw(h('div', { class: 'tag ok', text: `Loaded ${res.data.loaded.length} parts${res.data.recipeCards ? `, ${res.data.recipeCards} recipe cards` : ''}` }));
      } });
    fill(box, 
      h('h2', { text: 'Recipes and answers' }),
      h('div', { class: 'small muted', text: 'Load the kitchen-book file from Claude: your recipes and every answer given so far. Importing again replaces what’s here; earlier versions are kept.' }),
      parts.length ? h('div', { class: 'list' }, parts.map((p) => h('div', {}, h('span', { class: 'grow', text: NAMES[p.key] ?? p.key }), h('span', { class: 'small muted', text: when(p.updated_at) })))) : h('div', { class: 'tag', text: 'Nothing loaded yet' }),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, input), button),
      err, message ?? null,
    );
  };
  await draw();
  return box;
}

// The team, from Square, with PINs, access and email sign-in.
async function teamCard(me) {
  const box = h('section', { class: 'card', 'aria-label': 'Team' });
  const r = await api('GET', '/api/staff');
  const people = r.data.staff ?? [];
  const admin = r.data.canSetAccess;
  const owner = people.find((p) => p.access === 'owner');
  fill(box, 
    h('div', { class: 'row' }, h('h2', { class: 'grow', text: 'Team' }), h('span', { class: 'small muted', text: `${people.length} active` })),
    h('div', { class: 'small muted', text: `Names and job titles come from Square. Everyone is staff unless ${owner ? owner.name : 'the account owner'} or an administrator says otherwise. Managers approve and edit prep lists, plan the menu and see Performance. Administrators also run the team: access, PINs and email sign-in.` }),
    h('div', { class: 'list' }, people.map((p) => personRow(p, me, admin))),
  );
  return box;
}

const SIGN_IN_TAGS = { on: ['Email sign-in', 'ok'], invited: ['Invited', 'warn'] };

function personRow(p, me, admin) {
  const row = h('div');
  // Managers set staff PINs; administrators set anyone's but the owner's, and their access.
  const canPin = p.id === me.staffId || (admin && p.access !== 'owner') || p.access === 'staff';
  const canChange = admin && p.access !== 'owner' && p.id !== me.staffId;
  const draw = () => {
    const signIn = p.emailSignIn && p.access !== 'owner' ? SIGN_IN_TAGS[p.emailSignIn] : null;
    fill(row, 
      h('div', { class: 'grow' }, h('div', { text: p.name }), h('div', { class: 'small muted', text: [p.jobTitle, p.email].filter(Boolean).join(' · ') })),
      h('span', { class: `tag${p.access === 'staff' ? '' : ' blue'}`, text: ACCESS_NAMES[p.access] ?? p.access }),
      p.area && p.area !== 'both' ? h('span', { class: 'tag', text: AREA_NAMES[p.area] }) : null,
      signIn ? h('span', { class: `tag ${signIn[1]}`, text: signIn[0] }) : null,
      p.hasPin ? h('span', { class: 'tag ok', text: 'PIN set' }) : h('span', { class: 'tag', text: 'No PIN' }),
      canPin || canChange ? h('button', { class: 'btn', text: 'Change', onclick: () => personForm(row, p, { canPin, canChange }, draw) }) : null,
    );
  };
  draw();
  return row;
}

/** Access, PIN and email sign-in for one person. */
function personForm(container, p, { canPin, canChange }, done) {
  const err = h('div', { class: 'error' });
  const result = h('div');
  const access = canChange ? h('select', { 'aria-label': `Access for ${p.name}` },
    [['staff', 'Staff'], ['manager', 'Manager'], ['admin', 'Administrator']].map(([v, t]) => h('option', { value: v, text: t, selected: p.access === v ? true : undefined }))) : null;
  const area = canChange ? h('select', { 'aria-label': `Where ${p.name} works` },
    [['both', 'Kitchen and bar'], ['kitchen', 'Kitchen'], ['bar', 'Bar']].map(([v, t]) => h('option', { value: v, text: t, selected: (p.area ?? 'both') === v ? true : undefined }))) : null;
  const pin = canPin ? h('input', { inputmode: 'numeric', pattern: '[0-9]*', maxlength: '6', autocomplete: 'off', 'aria-label': `New PIN for ${p.name}`, placeholder: p.hasPin ? 'new PIN (optional)' : 'PIN, 4–6 digits' }) : null;
  const email = canChange ? h('input', { type: 'email', autocomplete: 'off', 'aria-label': `Email for ${p.name}`, placeholder: 'email for sign-in', value: p.email ?? '' }) : null;
  const emailRow = email ? h('div', {},
    h('div', { class: 'small muted', text: p.emailSignIn === 'on' ? 'Signs in with email. A new link lets them choose a new password.' : 'Managers and administrators can also sign in with email, on any phone or computer. Make a link and send it to them.' }),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, email), h('button', { class: 'btn', type: 'button', text: p.emailSignIn === 'on' ? 'New password link' : 'Make sign-in link', onclick: () => invite() }))) : null;
  const showEmail = () => { if (emailRow) emailRow.hidden = (access?.value ?? p.access) === 'staff'; };
  access?.addEventListener('change', showEmail);

  const saveArea = async () => {
    if (!area || area.value === (p.area ?? 'both')) return true;
    const a = await api('POST', `/api/staff/${p.id}/area`, { area: area.value });
    if (!a.ok) { err.textContent = a.data.error ?? 'That didn’t work.'; return false; }
    p.area = area.value;
    return true;
  };
  const saveAccess = async () => {
    if (!access || access.value === p.access) return true;
    if (access.value === 'staff' && p.emailSignIn === 'on' && !confirmText(`${p.name} won’t be able to sign in with email any more. Their PIN still works.`)) return false;
    const a = await api('POST', `/api/staff/${p.id}/access`, { access: access.value });
    if (!a.ok) { err.textContent = a.data.error ?? 'That didn’t work.'; return false; }
    p.access = access.value;
    if (p.access === 'staff') { p.emailSignIn = null; delete p.inviteUntil; } else p.emailSignIn ??= 'off';
    return true;
  };
  const invite = async () => {
    err.textContent = '';
    if (!(await saveAccess())) return;
    const r = await api('POST', `/api/staff/${p.id}/invite`, { email: email.value });
    if (!r.ok) return (err.textContent = r.data.error ?? 'That didn’t work.');
    p.email = r.data.email;
    if (p.emailSignIn !== 'on') p.emailSignIn = 'invited';
    const link = `${location.origin}${r.data.path}`;
    const field = h('input', { readonly: true, value: link, 'aria-label': 'Sign-in link', class: 'grow' });
    const copy = h('button', { class: 'btn dark', type: 'button', text: 'Copy link', onclick: async () => {
      try { await navigator.clipboard.writeText(link); copy.textContent = 'Copied'; } catch { field.select(); }
    } });
    const until = new Date(r.data.expiresAt).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    fill(result, h('div', { class: 'note' },
      h('div', { text: `Send this link to ${p.name} (${p.email}) by text or email. It works once, until ${until}, and lets them choose a password.` }),
      h('div', { class: 'row' }, field, copy)));
  };

  const form = h('form', { class: 'grow', onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (!(await saveAccess()) || !(await saveArea())) return;
      if (pin?.value) {
        const r = await api('POST', `/api/staff/${p.id}/pin`, { pin: pin.value });
        if (!r.ok) return (err.textContent = r.data.error ?? 'That didn’t work.');
        p.hasPin = true;
      }
      done();
    } },
    h('div', {}, h('div', { text: p.name }), h('div', { class: 'small muted', text: p.jobTitle ?? '' })),
    h('div', { class: 'row wrap' }, access, area, pin ? h('div', { class: 'grow' }, pin) : h('div', { class: 'grow' }), h('button', { class: 'btn dark', type: 'submit', text: 'Save' }), h('button', { class: 'btn', type: 'button', onclick: done, text: 'Done' })),
    emailRow, err, result);
  fill(container, form);
  showEmail();
  (pin ?? access)?.focus();
}

const confirmText = (text) => window.confirm(text);

/** PIN entry for yourself. */
function pinForm(container, person, onDone, onCancel) {
  const err = h('span', { class: 'error' });
  const input = h('input', { inputmode: 'numeric', pattern: '[0-9]*', maxlength: '6', autocomplete: 'off', 'aria-label': `New PIN for ${person.name}`, placeholder: '4–6 digits' });
  const form = h('form', { class: 'row grow wrap', onsubmit: async (e) => {
      e.preventDefault();
      const r = await api('POST', `/api/staff/${person.id}/pin`, { pin: input.value });
      if (!r.ok) return (err.textContent = r.data.error ?? 'That didn’t work.');
      onDone();
    } },
    h('div', { class: 'grow' }, h('div', { text: person.name }), err),
    input, h('button', { class: 'btn dark', type: 'submit', text: 'Save' }), h('button', { class: 'btn', type: 'button', onclick: onCancel, text: 'Cancel' }));
  fill(container, form);
  input.focus();
}

function ownPinCard(me) {
  const box = h('section', { class: 'card', 'aria-label': 'Your PIN' });
  const draw = () => fill(box, 
    h('h2', { text: 'Your PIN' }),
    h('div', { class: 'small muted', text: 'For signing in on a kitchen iPad. 4 to 6 digits, not a run like 1234.' }),
    h('div', { class: 'row' }, h('button', { class: 'btn', text: 'Set my PIN', onclick: () => {
      const slot = h('div', { class: 'row' });
      fill(box, h('h2', { text: 'Your PIN' }), slot);
      pinForm(slot, { id: me.staffId, name: me.name }, () => { draw(); box.append(h('div', { class: 'tag ok', text: 'Saved' })); }, draw);
    } })),
  );
  draw();
  return box;
}

// The restaurant's logo: on the bar at the left and on the sign-in screens.
function brandCard(me) {
  const box = h('section', { class: 'card', 'aria-label': 'Logo' });
  const err = h('div', { class: 'error' });
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', 'aria-label': 'Logo file' });
  const draw = () => fill(box,
    h('h2', { text: 'Logo' }),
    h('div', { class: 'small muted', text: 'Shown on the bar at the left and on the sign-in screens. A light logo on a dark background suits it best.' }),
    h('div', { class: 'logo-preview' }, brandMark('stage')),
    h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, input),
      h('button', { class: 'btn dark', text: 'Upload', onclick: async () => {
        const file = input.files?.[0];
        if (!file) return (err.textContent = 'Choose the file first.');
        // Scaled down to 800 px wide: sharp on any screen, small to load.
        const img = new Image();
        img.src = await new Promise((done) => { const fr = new FileReader(); fr.onload = () => done(fr.result); fr.readAsDataURL(file); });
        try { await img.decode(); } catch { return (err.textContent = 'That file isn’t an image.'); }
        const scale = Math.min(1, 800 / img.naturalWidth);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const res = await api('POST', '/api/brand/logo', { dataUrl: canvas.toDataURL('image/png') });
        if (!res.ok) return (err.textContent = res.data.error ?? 'Not saved.');
        await loadBrand();
        home(me);
      } }),
      BRAND.logo ? h('button', { class: 'link', text: 'Remove', onclick: async () => { await api('POST', '/api/brand/logo', { dataUrl: null }); await loadBrand(); home(me); } }) : null),
    err);
  draw();
  return box;
}

// Which POS categories are kitchen and which bar.
async function areasCard() {
  const box = h('section', { class: 'card', 'aria-label': 'Kitchen and bar' });
  const r = await api('GET', '/api/areas');
  const cats = r.data.categories ?? [];
  const err = h('div', { class: 'error' });
  fill(box,
    h('h2', { text: 'Kitchen and bar' }),
    h('div', { class: 'small muted', text: 'Which side of the menu each Square category belongs to. Menu, Performance and Today open on the side each person works (set under Team), and anyone can switch.' }),
    cats.length ? h('div', { class: 'list' }, cats.map((c) => {
      const pick = h('select', { 'aria-label': `Side for ${c.category}`, disabled: r.data.canEdit ? undefined : true },
        [['kitchen', 'Kitchen'], ['bar', 'Bar'], ['none', 'Neither']].map(([v, t]) => h('option', { value: v, text: t, selected: c.area === v ? true : undefined })));
      pick.addEventListener('change', async () => {
        const s = await api('POST', '/api/areas', { category: c.category, area: pick.value });
        err.textContent = s.ok ? '' : s.data.error ?? 'That didn’t save.';
      });
      return h('div', {}, h('div', { class: 'grow' }, h('div', { text: c.category }), h('div', { class: 'small muted', text: `${dollars(c.netSales)} in 120 days` })), pick);
    })) : h('div', { class: 'small muted', text: 'Categories show up here after the first Square sync.' }),
    err);
  return box;
}

// Kitchen iPads: set this one up, and give each a station.
async function deviceCard() {
  const box = h('section', { class: 'card', 'aria-label': 'Kitchen iPads' });
  const draw = async (message) => {
    const r = await api('GET', '/api/devices');
    const stations = r.data.stations ?? [];
    const devices = r.data.devices ?? [];
    const stationSelect = (value, label) => h('select', { 'aria-label': label },
      h('option', { value: '', text: 'Any station' }),
      stations.map((s) => h('option', { value: s.id, text: s.name, selected: s.id === value ? true : undefined })));
    const err = h('div', { class: 'error' });
    const here = devices.find((d) => d.thisOne);
    const name = h('input', { type: 'text', placeholder: 'e.g. Pizza station iPad', 'aria-label': 'Name for this iPad', required: true });
    const station = stationSelect('', 'Station for this iPad');
    const form = here ? null : h('form', { class: 'row wrap', onsubmit: async (e) => {
        e.preventDefault();
        const s = await api('POST', '/api/devices', { name: name.value, stationId: station.value || null });
        if (!s.ok) return (err.textContent = s.data.error ?? 'That didn’t work.');
        draw(h('div', { class: 'note', text: `This iPad is set up as “${name.value}”. Sign out, and cooks will see their names here.` }));
      } }, h('div', { class: 'grow' }, name), stations.length ? station : null, h('button', { class: 'btn dark', type: 'submit', text: 'Set up this iPad' }));
    const rows = devices.map((d) => {
      const pick = stationSelect(d.stationId, `Station for ${d.name}`);
      pick.addEventListener('change', async () => {
        const s = await api('POST', `/api/devices/${d.id}`, { stationId: pick.value || null });
        if (!s.ok) err.textContent = s.data.error ?? 'That didn’t work.';
      });
      return h('div', { class: 'wrap' },
        h('div', { class: 'grow' }, h('div', { text: d.name + (d.thisOne ? ' (this one)' : '') }), h('div', { class: 'small muted', text: d.lastSeen ? `Last used ${when(d.lastSeen)}` : 'Not used yet' })),
        stations.length ? pick : null,
        h('button', { class: 'btn', text: 'Remove', onclick: async () => {
          if (!confirmText(`Remove “${d.name}”? Anyone signed in on it is signed out, and it needs setting up again to use.`)) return;
          await api('POST', `/api/devices/${d.id}`, { revoke: true });
          draw();
        } }));
    });
    fill(box, 
      h('h2', { text: 'Kitchen iPads' }),
      h('div', { class: 'small muted', text: 'Set up each kitchen iPad once, signed in as a manager on it. Cooks then sign in with their name and PIN. Give an iPad a station and whoever signs in on it goes straight to that station’s prep list.' }),
      rows.length ? h('div', { class: 'list' }, rows) : null,
      form, err, message ?? null,
    );
  };
  await draw();
  return box;
}

start();
