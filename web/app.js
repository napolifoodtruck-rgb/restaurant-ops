// The web app. Plain modules, no build step. Every screen is built with h() from data the
// API returns, never from HTML strings, so names and messages can't inject markup.

const app = document.getElementById('app');
// Tapping a button while typing in a field: the field's change used to run on the way down
// (on blur), redraw part of the page and slide the button away before the tap landed, so the
// first tap did nothing. Now the tap keeps the field focused, and the field is committed just
// before the button's own action runs, so the button stays where it was tapped.
const typing = () => document.activeElement?.matches?.('input:not([type=checkbox]):not([type=radio]), textarea');
app.addEventListener('mousedown', (e) => { if (e.target.closest?.('button') && typing()) e.preventDefault(); }, true);
app.addEventListener('click', (e) => { if (e.target.closest?.('button') && typing()) document.activeElement.blur(); }, true);

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
  ideas: 'M9 18h6 M10 21h4 M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
  inventory: 'M4 7l8-4 8 4v10l-8 4-8-4z M4 7l8 4 8-4 M12 11v10',
  floor: 'M3 9h18 M6 9v11 M18 9v11 M9 9V5h6v4',
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

/** What to say when the server answered with an error and no reason (a restart, a deploy, a time-out). */
function failText(status) {
  if (status === 401) return 'You’re signed out (error 401). Sign in again; this screen wasn’t saved.';
  if (status === 403) return 'This sign-in isn’t allowed to do that (error 403).';
  if (status === 404) return 'That’s no longer there (error 404). Go back and reload.';
  if (status === 413) return 'That’s too big to save in one go (error 413).';
  if (status >= 500) return `The app didn’t answer (error ${status}). It may be updating: wait a minute and try again. Nothing on this screen was lost.`;
  return `Didn’t work (error ${status}). Try again.`;
}

/** An amount as cooks write it: 2, 1.5, 1,5, .5, 1/2, 1 1/2, ½, 1½. NaN when it can't be read; '' when empty. */
const FRACTIONS = { '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875, '⅕': 0.2 };
function parseAmount(text) {
  const t = String(text ?? '').trim().replace(/(\d),(\d)/g, '$1.$2').replace(/(\d)\s*-\s*(\d+\s*\/)/, '$1 $2').replace(/\s+/g, ' ');
  if (!t) return '';
  const m = t.match(/^(\d*\.?\d+)?\s*(?:([½⅓⅔¼¾⅛⅜⅝⅞⅕])|(\d+)\s*\/\s*(\d+))?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return NaN;
  const whole = m[1] ? Number(m[1]) : 0;
  const frac = m[2] ? FRACTIONS[m[2]] : m[3] ? Number(m[3]) / Number(m[4]) : 0;
  if (m[3] && !(Number(m[4]) > 0)) return NaN;
  // "1 1/2" is one and a half; a bare "3/4" is three quarters.
  const v = whole + frac;
  return Number.isFinite(v) ? v : NaN;
}

async function api(method, path, body) {
  const el = pressed && Date.now() - pressedAt < 500 && pressed.isConnected && !pressed.classList.contains('busy') ? pressed : null;
  if (el) { pressed = null; busy(el, true); working(true); }
  try {
    const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok && !data.error) data.error = failText(res.status);
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
// One refresh at a time. A refresh that started before a later change is thrown away rather than
// drawn (its data is already old: taking off two dishes quickly used to bring the second one back
// for a moment); the next refresh, after the last change, is the one that shows.
let inPlace = false, actionsOut = 0, actionsStarted = 0, lastRefresh = null, waitingRefresh = null, inFlight = null, queuedRefresh = null;
function show(...nodes) {
  const y = window.scrollY, keep = inPlace;
  inPlace = false;
  if (keep && actionsOut > 0) { waitingRefresh = lastRefresh; return; }
  // Stale: something was changed after this refresh asked for its data, or they've gone to another tab.
  if (keep && inFlight && (actionsStarted !== inFlight.startedAt || tabNow() !== inFlight.tab)) { if (actionsStarted !== inFlight.startedAt) queuedRefresh ??= lastRefresh; return; }
  fill(app, ...nodes);
  if (keep) window.scrollTo(0, y);
}
/** Redraws a screen in place: call it after an action on that screen succeeds. */
function refreshInPlace(draw) {
  lastRefresh = draw;
  if (actionsOut > 0) { waitingRefresh = draw; return; }
  if (inFlight) { queuedRefresh = draw; return; }
  inFlight = { startedAt: actionsStarted, tab: tabNow() };
  inPlace = true;
  return Promise.resolve(draw()).finally(() => {
    inFlight = null; inPlace = false;
    if (queuedRefresh) { const q = queuedRefresh; queuedRefresh = null; refreshInPlace(q); }
  });
}
/** An action on the page (a save): while any are out, refreshes wait; the last one to finish runs the latest. */
const tabNow = () => app.querySelector('.shell')?.dataset.active;
async function pageAction(fn) {
  const tab = tabNow();
  actionsOut++; actionsStarted++;
  try { return await fn(); } finally {
    actionsOut--;
    // Gone to another tab meanwhile: the save still counts, but don't pull them back to redraw this one.
    if (!actionsOut && waitingRefresh) { const r = waitingRefresh; waitingRefresh = null; if (tabNow() === tab) refreshInPlace(r); }
  }
}
/**
 * Where a page was opened from, so finishing there (Save, Cancel, ←) goes back to it: the same
 * page, freshly loaded, scrolled to where it was, with its own tab lit on the left.
 */
function returnTo(label, redraw) {
  const y = window.scrollY, rail = tabNow();
  return { label, rail, go: async (saved) => { await redraw(saved); requestAnimationFrame(() => window.scrollTo(0, y)); } };
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
  return h('div', { class: `page${opts.sideFirst ? ' side-first' : ''}${opts.sticky ? ' sticky-side' : ''}` }, middle,
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
  if (BRAND.name) document.title = BRAND.name;
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

/**
 * The home-screen icon: the logo centered on a black square (iPads want a square; the logo is wide).
 * Made here from the uploaded logo, by the owner's browser, whenever the logo is newer than the icon.
 */
async function makeIcon() {
  if (!BRAND.logo || BRAND.iconFresh) return;
  const img = new Image();
  img.src = BRAND.logo;
  try { await img.decode(); } catch { return; }
  const size = 512, pad = 0.14;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, size, size);
  const k = Math.min((size * (1 - 2 * pad)) / img.naturalWidth, (size * (1 - 2 * pad)) / img.naturalHeight);
  const w = img.naturalWidth * k, hh = img.naturalHeight * k;
  g.drawImage(img, (size - w) / 2, (size - hh) / 2, w, hh);
  const res = await api('POST', '/api/brand/icon', { dataUrl: canvas.toDataURL('image/png') });
  if (res.ok) BRAND.iconFresh = true;
}

async function start() {
  if (!BRAND.name) await loadBrand();
  const invite = location.hash.match(/^#invite=([A-Za-z0-9_-]+)$/);
  if (invite) return inviteScreen(invite[1]);
  const me = await api('GET', '/api/me');
  // On a kitchen iPad that belongs to a station, everyone lands on that station's prep.
  // Cooks, and anyone on a kitchen iPad, land on Prep: on an iPad that belongs to a station, that station's list.
  stopFloorIdle();
  if (me.ok) {
    const who = { ...me.data.me, ...(me.data.device ? { device: me.data.device } : {}) };
    if (canAdminister(who)) makeIcon();
    // A manager on a front-of-house iPad (signed in with their PIN): the board, with Manage.
    if (who.device?.floorPostId && atLeast(who.roleLevel, 'manager')) return floorBoard({ me: who });
    return who.device || !atLeast(who.roleLevel, 'manager') ? prepHome(who) : todayScreen(who);
  }
  const device = await api('GET', '/api/devices/staff');
  // A front-of-house iPad: its post's board, no sign-in. Otherwise the cooks' names.
  if (device.ok && device.data.floorPostId) return floorBoard({ device: { floorPostId: device.data.floorPostId } });
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
    ['today', 'Today', todayScreen], ['ideas', 'Ideas', manager && ideasScreen], ['prep', 'Prep', prepHome], ['floor', 'Service', manager && floorManage], ['recipes', 'Recipes', recipesScreen], ['menu', 'Menu', manager && menuScreen], ['margins', 'Performance', manager && marginsScreen], ['reports', 'Reports', manager && reportsScreen], ['orders', 'Orders', manager && ordersScreen], ['inventory', 'Inventory', atLeast(me.roleLevel, 'chef') && inventoryHome],
  ];
  return h('div', { class: 'shell', 'data-active': active },
    h('nav', { class: 'rail', 'aria-label': 'Main' },
      h('div', { class: 'logo' }, brandMark('rail')),
      nav.map(([key, label, go]) => h('button', { class: active === key ? 'on' : '', 'data-key': key, disabled: !go, title: go ? label : 'Coming next', onclick: go ? () => go(me) : undefined }, icon(key), label)),
      h('button', { class: active === 'settings' ? 'on' : '', 'data-key': 'settings', onclick: () => home(me) }, icon('settings'), 'Settings'),
      h('div', { class: 'spacer' }),
      whoAmI(me),
    ),
    h('main', {}, content),
  );
}

const LEVEL_NAMES = { line: 'Line', lead: 'Lead', sous: 'Sous chef', chef: 'Chef', manager: 'Manager', owner: 'Owner' };
const initialsOf = (name) => (name ?? '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
/**
 * Who's signed in, always at the bottom of the left bar: initials and level. One tap logs out (on a
 * station's iPad, the iPad stays set up and goes back to the names for the next cook).
 */
function whoAmI(me) {
  const level = LEVEL_NAMES[me.roleLevel] ?? me.roleLevel;
  // One word that fits the bar; on a station's iPad it goes back to the names for the next cook.
  const word = 'Logout';
  const chip = h('button', { class: 'me-chip', title: `${me.name} · ${level}${me.device ? ` · ${me.device.name ?? 'this iPad'}` : ''}. Tap to ${word.toLowerCase()}.`, 'aria-label': `${word} (${me.name}, ${level})`,
    onclick: async () => { busy(chip, true); await api('POST', '/api/logout'); start(); } },
    h('span', { class: 'me-dot', text: initialsOf(me.name) }), h('span', { class: 'me-level', text: level }), h('span', { class: 'me-out', text: word }));
  return h('div', { class: 'me' }, chip);
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
  const toolbar = h('section', { class: 'card toolbar one-row' },
    // Full price or specials alone, where specials buttons (Tuesday $10, half-price Wednesday) sold.
    m.hasSpecials ? seg('Which sales', [['All', 'all'], ['Full price', 'full'], ['Specials', 'special']].map(([text, p]) => [text, (state.price ?? 'all') === p, () => marginsScreen(me, { ...state, price: p })])) : null,
    periodPicker(presets, chosen ? chosen[0] : 'custom', { from: m.from, to: m.to }, (key, r) => {
      const preset = presetRanges().find(([label]) => label === key);
      marginsScreen(me, { ...state, range: key === 'custom' ? r : preset?.[1] ?? null });
    }),
    mode ? h('div', { class: 'tool-end' }, seg('Table or charts', [['Table', mode !== 'charts', () => again({ mode: 'table' })], ['Charts', mode === 'charts', () => again({ mode: 'charts' })]])) : null);
  return names.length > 1 ? [categoryStrip(me, m, current, again), toolbar] : toolbar;
}

/**
 * The categories across the top of Performance, one tile each: its cost against the goal and
 * its gross profit, so the strip reads as a summary before it's a way to switch. Scrolls
 * sideways when there are more than fit.
 */
function categoryStrip(me, m, current, again) {
  const bar = sideOf(me) === 'bar';
  const goal = bar ? POUR_COST_GOAL : FOOD_COST_GOAL;
  const tile = (name, lines, label) => h('button', { class: `cat-tile${name === current ? ' on' : ''}`, role: 'tab', 'aria-selected': String(name === current), 'aria-label': label, onclick: () => again({ category: name }) },
    h('span', { class: 'cat-name', text: name }), ...lines);
  const tiles = [
    ...m.categories.map((c) => {
      const st = foodCostStatus(c.foodCostShare, goal);
      return tile(c.name, [h('span', { class: `cat-pct ${st.cls}`, text: `${pct(c.foodCostShare)} ${bar ? 'pour' : 'food'}` }), h('span', { class: 'cat-sub', text: `${dollars(c.leftOver)} profit` })],
        `${c.name}: ${pct(c.foodCostShare)} ${bar ? 'pour' : 'food'} cost, ${st.label.replace(/^\S+\s/, '').toLowerCase()}; ${dollars(c.leftOver)} gross profit`);
    }),
    ...(m.salesOnly ?? []).map((c) => tile(c.name, [h('span', { class: 'cat-pct muted', text: 'no costs yet' }), h('span', { class: 'cat-sub', text: `${dollars(c.netSales)} sales` })], `${c.name}: no costs yet, ${dollars(c.netSales)} sales`)),
  ];
  const strip = h('div', { class: 'cat-strip', role: 'tablist', 'aria-label': 'Category' }, tiles);
  // Keep the chosen one in view when the strip scrolls.
  requestAnimationFrame(() => strip.querySelector('.cat-tile.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  return strip;
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
function drillDonut(root, opts = {}) {
  if (!root.items.some((x) => x.value > 0)) return null;
  const large = Boolean(opts.large);
  const box = h('div', { class: `drill${large ? ' large' : ''}` });
  const stack = opts.stack ? [...opts.stack] : [root];
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
    // Fill the ring: slices until 90% is shown (up to twelve), so Other is only the small tail;
    // a tail of one is just shown, and Other opens into the rest.
    const whole = sorted.reduce((a, x) => a + x.value, 0);
    // Expanded, it shows up to fifty, until 99% is in view.
    const most = large ? 50 : 12, enough = large ? 0.99 : 0.9;
    let n = 0, shownSoFar = 0;
    while (n < sorted.length && n < most && (n < 5 || shownSoFar / whole < enough)) shownSoFar += sorted[n++].value;
    if (sorted.length - n === 1) n++;
    const top = sorted.slice(0, n);
    const rest = sorted.slice(n);
    const parts = [...top.map((x, i) => ({ ...x, color: x.color ?? (large ? BIG_COLORS[i] : PIE_COLORS[i]) })),
      ...(rest.length ? [{ name: `Other (${rest.length})`, value: rest.reduce((a, x) => a + x.value, 0), color: OTHER, open: () => ({ title: node.title, crumb: 'Other', format, items: rest }) }] : [])];
    const total = parts.reduce((a, x) => a + x.value, 0);
    const R = 74, r = 48, C = 80;
    const svg = s('svg', { viewBox: '0 0 160 160', class: 'donut', role: 'img', 'aria-label': parts.map((x) => `${x.name} ${Math.round((x.value / total) * 100)}%`).join(', ') });
    const deep = stack.length > 1;
    const centre = h('div', { class: `donut-centre${deep ? ' can-back' : ''}` });
    const showCentre = (title, value, sub) => fill(centre,
      deep ? h('button', { class: 'donut-back', 'aria-label': `Back to ${stack[stack.length - 2].crumb ?? 'the start'}`, onclick: () => back() }, `‹ ${stack[stack.length - 2].crumb ?? 'Back'}`) : null,
      h('div', { class: 'donut-big', text: value }), h('div', { class: 'small muted', text: title }), sub ? h('div', { class: 'small muted', text: sub }) : null);
    const reset = () => (node.centre ? showCentre(node.centre.label, node.centre.big) : showCentre(node.title, format(total)));
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
    const expand = !large ? h('button', { class: 'link pie-expand', 'aria-label': 'Expand this chart', title: 'Open it large, with up to 50 slices', onclick: () => openBigPie(box, stack) }, '⤢ Expand') : null;
    if (large) return [trail, h('div', { class: 'pie-big-body' }, h('div', { class: 'donut-wrap' }, svg, centre), h('div', { class: 'donut-legend' }, legendRows)), node.note ?? null];
    return [h('div', { class: 'pie-tools' }, trail ?? h('span'), expand), h('div', { class: 'donut-wrap' }, svg, centre), h('div', { class: 'donut-legend' }, legendRows), node.note ?? null,
      !deep && parts.some((x) => x.open) ? h('div', { class: 'small muted', text: 'Click a slice to go a layer deeper; the middle brings you back.' }) : null];
  }
  draw();
  return box;
}

/**
 * A pie, large, at the top of the middle of the page: up to 50 slices with their own colors and the
 * legend beside it, starting from the layer the small one was on. Close puts it away.
 */
/** Any chart, opened large at the top of the page's main column, with a Close. */
function openBig(from, title, chart) {
  const main = from.closest('.page')?.querySelector('.page-main') ?? app.querySelector('main');
  if (!main) return;
  main.querySelector('.pie-big')?.remove();
  const card = h('section', { class: 'card pie-big', 'aria-label': title },
    h('div', { class: 'row' }, h('h2', { class: 'grow', text: title }), h('button', { class: 'btn small-btn', text: 'Close', onclick: () => card.remove() })),
    chart);
  main.prepend(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  card.querySelector('button')?.focus();
}
function openBigPie(box, stack) {
  const main = box.closest('.page')?.querySelector('.page-main') ?? app.querySelector('main');
  if (!main) return;
  main.querySelector('.pie-big')?.remove();
  const title = box.closest('section')?.querySelector('.small.strong')?.textContent ?? 'Chart';
  const big = drillDonut(stack[0], { large: true, stack });
  const card = h('section', { class: 'card pie-big', 'aria-label': title },
    h('div', { class: 'row' }, h('h2', { class: 'grow', text: title }), h('button', { class: 'btn small-btn', text: 'Close', onclick: () => card.remove() })),
    big);
  main.prepend(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  card.querySelector('button')?.focus();
}

/**
 * A dish or drink a layer down: full price against each discount day, or the paid add-ons only, so the
 * whole ring is what add-ons brought in (free changes like "no basil" have no money to show).
 */
async function breakdownLayer(m, query) {
  const r = await api('GET', `/api/costs/breakdown?${query}&from=${m.from}&to=${m.to}`);
  if (!r.ok) return null;
  const d = r.data;
  if (d.versions?.length) return { title: 'sales', format: dollars, items: d.versions.map((v) => ({ name: `${v.name} (${v.quantity.toLocaleString()} sold)`, value: v.value })) };
  if (!d.addOns.length) return null;
  const extra = d.addOns.reduce((a, x) => a + x.value, 0);
  return { title: 'from add-ons', format: dollars, items: d.addOns.map((a) => ({ name: `${a.name} (${a.uses.toLocaleString()}×)`, value: a.value })),
    note: h('div', { class: 'small muted', text: `Add-ons brought in ${dollars(extra, { exact: true })} on top of ${d.plates.toLocaleString()} ${d.name} sold: ${d.sales ? Math.round((extra / d.sales) * 1000) / 10 : 0}% of its sales.` }) };
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
  const r = await api('GET', `/api/margins?area=${sideOf(me)}${state.range ? `&from=${state.range.from}&to=${state.range.to}` : ''}${state.price && state.price !== 'all' ? `&price=${state.price}` : ''}`);
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
  const maxValue = Math.max(...dishes.map((d) => (perDay ? d.leftPerDay ?? 0 : d.leftTotal)), 1);
  const partOfPeriod = (d) => d.daysOn && d.daysOn < m.openDays;
  const rows = dishes.map((d) => {
    // Every plate's bar is the same length, split at its food-cost share, so the column reads straight down.
    const foodShare = d.averagePrice > 0 ? Math.min(1, d.plateCost / d.averagePrice) : 0;
    const plate = h('div', { class: 'pricebar', title: `${pct(foodShare)} of the price is food` }, h('div', { class: 'food' }), h('div', { class: 'left' }));
    plate.style.width = 'calc(100% - 92px)';
    plate.firstChild.style.width = `${(foodShare * 100).toFixed(2)}%`;
    const [roleText, roleCls] = ROLE[d.role] ?? ['', ''];
    const value = perDay ? d.leftPerDay ?? 0 : d.leftTotal;
    const other = perDay ? `${dollars(d.leftTotal)} in all` : d.leftPerDay !== undefined ? `${dollars(d.leftPerDay)} a day` : '';
    const note = d.offSince ? `off the menu since ${shortDate(d.offSince)}` : partOfPeriod(d) ? `on the menu ${d.daysOn} of ${m.openDays} days, since ${shortDate(d.firstSold)}` : null;
    const opened = state.open?.includes(d.name);
    // Roles judge money over the whole period; in the per-day view, a dish that joined partway is just marked new.
    const role = d.offSince ? null : perDay ? (partOfPeriod(d) ? h('span', { class: 'tag blue', text: 'New' }) : null) : roleText ? h('span', { class: `tag ${roleCls}`, text: roleText }) : null;
    const row = h('div', { class: `mrow${d.offSince ? ' off' : ''}` },
      h('div', { class: 'name-cell' }, h('button', { class: 'name linkish', 'aria-expanded': opened ? 'true' : 'false', title: 'Show the plate, ingredient by ingredient', onclick: () => { const y = window.scrollY; again({ open: opened ? state.open.filter((n) => n !== d.name) : [...(state.open ?? []), d.name] }); window.scrollTo(0, y); } }, d.name, h('span', { class: 'muted', text: opened ? ' ▾' : ' ▸' })), note ? h('div', { class: 'small muted', text: note }) : null, role),
      h('div', { class: 'plate-cell' }, h('div', { class: 'row tight' }, plate,
        // What guests paid on average, beside the menu price when they differ, so the number isn't a mystery.
        h('span', { class: 'price-pair', title: 'What guests paid on average in this period, after specials, discounts and comps. The menu price is today’s price in Square.' },
          h('span', { class: 'small', text: `${dollars(d.averagePrice, { cents: true })} avg` }),
          d.listPrice && m.price !== 'special' && Math.abs(d.listPrice - d.averagePrice) >= 0.05 ? h('span', { class: 'small muted', text: `${dollars(d.listPrice, { cents: true })} menu` }) : null,
          d.priceChange ? h('span', { class: 'small price-moved', title: priceChangeText(d.priceChange), text: `${d.priceChange.to > d.priceChange.from ? '↑' : '↓'} since ${shortDate(d.priceChange.week)}` }) : null)),
        h('div', { class: 'small', text: `${dollars(d.plateCost, { cents: true })}${d.estimated ? '*' : ''} food (${Math.round(foodShare * 100)}%) · ${dollars(d.leftPerPlate, { cents: true })} profit` })),
      h('div', { class: 'num' }, h('div', { text: d.sold.toLocaleString() }), d.soldPerDay !== undefined ? h('div', { class: 'small muted', text: `${d.soldPerDay}/day` }) : null),
      h('div', {}, h('div', { class: 'row tight' }, (() => { const t = h('div', { class: 'total' }); t.style.width = `calc((100% - 64px) * ${(Math.max(0, value) / maxValue).toFixed(4)})`; return t; })(), h('b', { text: dollars(value) })), other ? h('div', { class: 'small muted', text: other }) : null),
      trendCell(d.trend),
    );
    return opened ? [row, plateDetail(d, bar ? POUR_COST_GOAL : FOOD_COST_GOAL)] : row;
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
    h('div', { class: 'small muted', text: `${cat.dishes.length} ${bar ? 'drinks' : 'dishes'} · ${days} days` }),
    foodCostPanel(`${bar ? 'Pour' : 'Food'} cost by week${m.price === 'full' ? ', full price' : m.price === 'special' ? ', specials' : ''}`, cat.foodCostShare, m.weeks, fc, bar ? POUR_COST_GOAL : FOOD_COST_GOAL),
    // What the specials do to it: full price and specials apart, and how much of the money was on specials.
    cat.byPrice ? (() => {
      const goal = bar ? POUR_COST_GOAL : FOOD_COST_GOAL;
      const part = (label, x) => h('span', {}, `${label} `, h('b', { class: foodCostStatus(x.foodCostShare, goal).cls, text: pct(x.foodCostShare) }));
      return h('div', { class: 'small price-line' }, part('Full price', cat.byPrice.full), ' · ', part('Specials', cat.byPrice.special),
        h('span', { class: 'muted', text: ` · ${Math.round(cat.byPrice.specialShare * 100)}% of sales on specials` }));
    })() : null,
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
    h('div', { class: 'small muted', text: 'Avg is what guests paid on average, after specials, discounts and comps; menu is today’s price in Square. * part of the recipe still uses an estimated price. Top earners together bring in 80% of the money in the period. Trend: plates per open day, week by week; weeks off the menu are left out.' }),
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
/** "Menu price went up around the week of Aug 17: about $18.25 before, $20.25 since." */
const priceChangeText = (c) => `Menu price went ${c.to > c.from ? 'up' : 'down'} around the week of ${shortDate(c.week)}: about ${dollars(c.from, { cents: true })} a plate before, ${dollars(c.to, { cents: true })} since (full price, add-ons included). The period's average mixes the two.`;
function plateDetail(d, goal = FOOD_COST_GOAL) {
  // Full price and specials apart: what each sold, for how much, and its food or pour cost.
  const parts = d.byPrice ? [['Full price', d.byPrice.full], ['Specials', d.byPrice.special]].filter(([, x]) => x) : [];
  const priceSplit = parts.length ? h('div', { class: 'price-split' }, parts.map(([label, x]) => {
    const st = foodCostStatus(x.foodCostShare, goal);
    return h('div', { class: 'ps-col' }, h('div', { class: 'small muted strong', text: label }),
      h('div', { class: 'small', text: `${x.sold.toLocaleString()} sold · ${dollars(x.averagePrice, { cents: true })} average` }),
      h('div', { class: `ps-pct ${st.cls}`, text: `${pct(x.foodCostShare)} cost` }));
  })) : null;
  return h('div', { class: 'plate-detail' }, d.priceChange ? h('div', { class: 'note small', text: priceChangeText(d.priceChange) }) : null, priceSplit,
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
// Pies can have up to twelve slices: the six series colors, then six more that stay apart from them and from Other.
const PIE_COLORS = [...SERIES, '#7c5cff', '#0097a7', '#a16207', '#be185d', '#4d7c0f', '#1e3a8a'];
// Fifty for an expanded pie: the twelve first, then hues spread around the wheel at three depths, none grey.
const BIG_COLORS = [...PIE_COLORS, ...Array.from({ length: 38 }, (_, i) => `hsl(${Math.round((i * 137.5 + 20) % 360)}, ${i % 2 ? 55 : 70}%, ${i % 3 === 0 ? 38 : i % 3 === 1 ? 52 : 64}%)`)];
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

/**
 * Each dish as a bubble: how often it sells (plates per open day it was on the menu) across,
 * and up the side one of three measures, picked with a switch: food cost (low at the top),
 * profit per plate, or total profit. A bubble's size is its total gross profit, so a cheap dish
 * that carries the menu still reads as big. The dashed lines are the category's averages,
 * splitting it four ways. (Menu engineering after Kasavana and Smith, 1982, and Miller's
 * food-cost version, 1980; the words here are the app's own.)
 */
const MATRIX_Y = {
  cost: { label: 'Food cost', short: 'Food cost %', axis: 'Lower food cost ↑', value: (d) => d.foodCostShare, invert: true, fmt: (v) => `${Math.round(v * 100)}%`,
    corners: ['Low cost, sells less: feature it', 'Sells, low cost: keep it up', 'Sells less, higher cost: rethink', 'Popular, higher cost: watch portions and price'] },
  plate: { label: 'Profit per plate', short: 'Profit per plate', axis: 'Profit per plate ↑', value: (d) => d.leftPerPlate, fmt: (v) => `$${Math.round(v)}`,
    corners: ['Earns well, sells less: feature it', 'Sells and earns: keep it up', 'Sells less, earns less: rethink', 'Popular, lower per plate: your volume'] },
  total: { label: 'Total profit', short: 'Total profit', axis: 'Gross profit in the period ↑', value: (d) => d.leftTotal, fmt: (v) => (v >= 1000 ? `$${Math.round(v / 100) / 10}k` : `$${Math.round(v)}`),
    corners: ['Earns well for what it sells', 'Carries the menu', 'A small part of the menu', 'Busy for what it earns'] },
};
function menuMatrix(cat, m, state, again) {
  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e; };
  const bar = m.area === 'bar';
  const key = MATRIX_Y[state.matrixY] ? state.matrixY : 'cost';
  const mode = MATRIX_Y[key];
  const label = (t) => (bar ? t.replace(/food cost/gi, (w) => (w[0] === 'F' ? 'Pour cost' : 'pour cost')).replace(/plate/g, 'drink') : t);
  const dishes = cat.dishes.filter((d) => !d.offSince && d.sold > 0 && mode.value(d) !== null && mode.value(d) !== undefined)
    .map((d) => ({ ...d, x: d.soldPerDay ?? d.sold / Math.max(1, m.openDays), y: mode.value(d) }));
  const pick = h('div', { class: 'seg', role: 'group', 'aria-label': 'Up the side' }, Object.entries(MATRIX_Y).map(([k, v]) =>
    h('button', { class: k === key ? 'on' : '', 'aria-pressed': String(k === key), text: label(v.short), onclick: () => again({ matrixY: k }) })));
  const card = (...body) => h('section', { class: 'card' }, h('div', { class: 'row wrap' }, h('h2', { class: 'grow', text: `${cat.name}: what sells against what it earns` }), pick), ...body);
  if (dishes.length < 3) return card(h('p', { class: 'muted', text: 'Needs at least three dishes with sales and costs.' }));

  const W = 720, H = 400, L = 60, R = 24, T = 22, B = 42;
  // Scales fit the dishes (none of these is a total that needs zero), with nice round steps.
  const ys = dishes.map((d) => d.y), lo = Math.min(...ys), hi = Math.max(...ys), spread = Math.max(hi - lo, Math.abs(hi) * 0.05, 1e-6);
  const raw = spread / 5, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((v) => v >= raw) ?? raw;
  const y0 = Math.max(lo >= 0 ? 0 : -Infinity, Math.floor((lo - spread * 0.12) / step) * step), y1 = Math.ceil((hi + spread * 0.12) / step) * step;
  const xMax = Math.max(...dishes.map((d) => d.x)) * 1.1;
  const x = (v) => L + (v / xMax) * (W - L - R);
  const y = (v) => { const f = (v - y0) / (y1 - y0); return T + (mode.invert ? f : 1 - f) * (H - T - B); };
  const maxTotal = Math.max(...dishes.map((d) => Math.max(0, d.leftTotal)), 1);
  const rOf = (d) => 5 + 15 * Math.sqrt(Math.max(0, d.leftTotal) / maxTotal);
  // Colour follows total profit too: red well under the category's average dish, amber around it, green well over.
  const avgTotal = dishes.reduce((a, d) => a + d.leftTotal, 0) / dishes.length;
  const mix = (c1, c2, t) => { const p = (c, i) => parseInt(c.slice(1 + 2 * i, 3 + 2 * i), 16); return `rgb(${[0, 1, 2].map((i) => Math.round(p(c1, i) + (p(c2, i) - p(c1, i)) * t)).join(',')})`; };
  const colorOf = (d) => { const t = Math.max(0, Math.min(1, (d.leftTotal / Math.max(1, avgTotal) - 0.4) / 1.2)); return t < 0.5 ? mix('#B42318', '#C98A14', t * 2) : mix('#C98A14', '#2E7D4F', (t - 0.5) * 2); };
  const xAvg = dishes.reduce((a, d) => a + d.x, 0) / dishes.length;
  const sold = dishes.reduce((a, d) => a + d.sold, 0), left = dishes.reduce((a, d) => a + d.leftTotal, 0);
  const yAvg = key === 'cost' ? cat.foodCostShare : key === 'plate' ? left / Math.max(1, sold) : left / dishes.length;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', class: 'matrix-chart', 'aria-label': `${cat.name}: plates a day against ${label(mode.label).toLowerCase()}. ${dishes.map((d) => `${d.name} ${d.x.toFixed(1)} a day, ${mode.fmt(d.y)}, ${dollars(d.leftTotal)} profit`).join('; ')}` });
  const [tl, tr, bl, br] = mode.corners.map(label);
  const corner = (text, cx, cy, anchor) => svg.append(el('text', { x: cx, y: cy, 'text-anchor': anchor, class: 'mx-quad' }, text));
  corner(tl, L + 8, T + 14, 'start'); corner(tr, W - R - 8, T + 14, 'end'); corner(bl, L + 8, H - B - 8, 'start'); corner(br, W - R - 8, H - B - 8, 'end');
  for (let v = y0; v <= y1 + step / 1000; v += step) svg.append(el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }), el('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, mode.fmt(v)));
  const xStep = xMax > 40 ? 10 : xMax > 16 ? 5 : xMax > 6 ? 2 : xMax > 3 ? 1 : 0.5;
  for (let v = 0; v <= xMax; v += xStep) svg.append(el('text', { x: x(v), y: H - B + 18, 'text-anchor': 'middle', class: 'tick' }, String(v)));
  svg.append(el('text', { x: (L + W - R) / 2, y: H - 4, 'text-anchor': 'middle', class: 'mx-axis' }, `${bar ? 'Sold' : 'Plates'} a day it was on the menu →`));
  svg.append(el('text', { x: 14, y: (T + H - B) / 2, 'text-anchor': 'middle', class: 'mx-axis', transform: `rotate(-90 14 ${(T + H - B) / 2})` }, label(mode.axis)));
  svg.append(el('line', { x1: x(xAvg), x2: x(xAvg), y1: T, y2: H - B, class: 'mx-avg' }), el('line', { x1: L, x2: W - R, y1: y(yAvg), y2: y(yAvg), class: 'mx-avg' }));

  // Names placed clear of each other and of the bubbles: right, else left, else nudged up or down.
  const taken = dishes.map((d) => { const r = rOf(d); return { x0: x(d.x) - r, x1: x(d.x) + r, y0: y(d.y) - r, y1: y(d.y) + r }; });
  const hits = (b) => taken.some((t) => b.x0 < t.x1 && b.x1 > t.x0 && b.y0 < t.y1 && b.y1 > t.y0);
  const place = (cx, cy, r, text) => {
    const w = text.length * 7 + 4;
    for (const dy of [0, -14, 14, -28, 28, -42, 42]) {
      for (const side of [1, -1]) {
        const lx = side > 0 ? cx + r + 4 : cx - r - 4 - w;
        const box = { x0: lx, x1: lx + w, y0: cy + dy - 9, y1: cy + dy + 5 };
        if (lx < L || lx + w > W - R || hits(box)) continue;
        taken.push(box);
        return { x: side > 0 ? lx : lx + w, y: cy + dy + 4, anchor: side > 0 ? 'start' : 'end', moved: dy !== 0 };
      }
    }
    return { x: cx + r + 4, y: cy + 4, anchor: 'start', moved: false };
  };
  const tip = el('g', { class: 'hover', visibility: 'hidden' }), box = el('rect', { width: 210, height: 52, rx: 3, class: 'hover-box' }), t1 = el('text', { class: 'hover-cost' }), t2 = el('text', { class: 'hover-date' }), t3 = el('text', { class: 'hover-date' });
  tip.append(box, t1, t2, t3);
  const bubbles = el('g', {}), names = el('g', {});
  // Biggest drawn first, so small bubbles sit on top and stay reachable.
  for (const d of [...dishes].sort((a, b) => b.leftTotal - a.leftTotal)) {
    const cx = x(d.x), cy = y(d.y), r = rOf(d), at = place(cx, cy, r, d.name);
    const g = el('g', { class: 'mx-dish', tabindex: '0' });
    g.append(el('circle', { cx, cy, r, class: 'mx-dot', fill: colorOf(d), stroke: colorOf(d) }));
    const show = () => {
      tip.setAttribute('visibility', 'visible');
      const bx = Math.min(cx + r + 6, W - R - 212), by = Math.max(T, cy - r - 56);
      box.setAttribute('x', bx); box.setAttribute('y', by);
      t1.setAttribute('x', bx + 10); t1.setAttribute('y', by + 17); t1.textContent = d.name;
      t2.setAttribute('x', bx + 10); t2.setAttribute('y', by + 32); t2.textContent = `${d.x.toFixed(1)} a day · ${pct(d.foodCostShare)} ${bar ? 'pour' : 'food'} · ${dollars(d.leftPerPlate, { cents: true })} each`;
      t3.setAttribute('x', bx + 10); t3.setAttribute('y', by + 46); t3.textContent = `${dollars(d.leftTotal)} gross profit in the period`;
    };
    g.addEventListener('pointerenter', show); g.addEventListener('focus', show);
    g.addEventListener('pointerleave', () => tip.setAttribute('visibility', 'hidden')); g.addEventListener('blur', () => tip.setAttribute('visibility', 'hidden'));
    bubbles.append(g);
    if (at.moved) names.append(el('line', { x1: cx, y1: cy, x2: at.anchor === 'start' ? at.x - 2 : at.x + 2, y2: at.y - 4, class: 'mx-leader' }));
    names.append(el('text', { x: at.x, y: at.y, 'text-anchor': at.anchor, class: 'mx-label' }, d.name));
  }
  svg.append(bubbles, names, tip);
  const avgText = key === 'cost' ? `${pct(yAvg)} ${bar ? 'pour' : 'food'} cost` : key === 'plate' ? `${dollars(yAvg, { cents: true })} a ${bar ? 'drink' : 'plate'}` : `${dollars(yAvg)} each`;
  return card(
    h('div', { class: 'small muted', text: `Each bubble is a ${bar ? 'drink' : 'dish'}, sized and coloured by the gross profit it brought in (red well under the average ${bar ? 'drink' : 'dish'}, green well over). Across: how many sold a day; up: ${label(mode.label).toLowerCase()}${mode.invert ? ', lowest at the top' : ''}. Dashed lines are ${cat.name.toLowerCase()}’s averages (${xAvg.toFixed(1)} a day, ${avgText}). Hover a bubble for its numbers.` }),
    h('div', { class: 'chart-wrap' }, svg));
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

  // Food cost week by week is in the side column, with Expand for a large view.
  return [menuMatrix(cat, m, state, again), plates, leftBars];
}

// ------------------------------------------------------------------ prep lists

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayName = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
const qty = (n) => (n === undefined || n === null ? '–' : Number.isInteger(n) ? String(n) : String(+n.toFixed(2)));
const plural = (n, unit) => (!unit ? '' : n === 1 || unit.includes('/') ? unit : unit.endsWith('h') ? `${unit}es` : `${unit}s`);
// A unit that starts with a number (1/3 pan) gets a ×, so "2 1/3 pan" doesn't read as two and a third.
const amountText = (n, unit) => (unit && /^\d/.test(String(unit).trim()) ? `${qty(n)} × ${unit}` : `${qty(n)}${unit ? ' ' + plural(n, unit) : ''}`);
const MASS_UNITS = new Set(['g', 'gram', 'grams', 'kg', 'oz', 'ounce', 'ounces', 'lb', 'lbs', 'pound', 'pounds', '#']);
const dimensionName = (u) => (MASS_UNITS.has(String(u ?? '').trim().toLowerCase()) ? 'mass' : 'other');
/** Grams for the line: pounds from a pound up, grams below. */
const weightText = (g) => { if (!(g > 0)) return ''; const lb = g / 453.59237; return lb >= 1 ? `${lb >= 10 ? Math.round(lb) : Math.round(lb * 10) / 10} lb` : `${Math.round(g)} g`; };
/** "(about 6.3 lb)" after an amount of a prep item, when its weight per unit is known; "about" when it's from the recipe. */
const weightOf = (n, l) => (l?.unitWeight && n > 0 && l.unitWeight.source !== 'unit' ? ` (${l.unitWeight.source === 'recipe' ? 'about ' : ''}${weightText(n * l.unitWeight.grams)})` : '');
/** "3 deep 1/9 pans (about 6.3 lb)". */
const amountWithWeight = (n, unit, l) => `${amountText(n, unit)}${weightOf(n, l)}`;
/** "2.1 lb each" under a unit, so the weight stays on everyone's radar. */
const eachWeight = (l) => (l?.unitWeight && l.unitWeight.source !== 'unit' ? `${l.unitWeight.source === 'recipe' ? 'about ' : ''}${weightText(l.unitWeight.grams)} each` : '');
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
      h('span', { class: 'hbar-label' }, h('span', { class: 'strong', text: i.name }), h('span', { class: 'small muted block', text: `${i.station ?? ''}${i.amount ? ` · ${amountText(i.amount, i.unit)}` : ''}` })),
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
  const toCount = countable.length;
  // How many are counted, kept up to date as each is tapped.
  const tallyBar = h('div'), tallyText = h('div', { class: 'small' }), endTally = h('span', { class: 'small muted' });
  const tally = () => { const n = countable.filter((l) => l.counted !== undefined).length; fill(tallyBar, progress(n, toCount)); tallyText.textContent = `${n} of ${toCount}`; endTally.textContent = `${n} of ${toCount} counted`; };
  tally();
  // A count is a tap: buttons sized to the item's par (halves when it's small), "other" for anything else.
  // The app's estimate sits beside them, never picked for the cook: they look, then tap.
  const choices = (l) => {
    const par = l.dayPar ?? l.par;
    const step = par !== undefined && (par < 4 || !Number.isInteger(par)) ? 0.5 : 1;
    const top = Math.max(par ?? 3, l.estimate ?? 0, l.counted ?? 0) + step * 2;
    const n = Math.round(top / step) + 1;
    return n > 12 ? null : Array.from({ length: n }, (_, k) => k * step);
  };
  const tapCount = (l, need, save) => {
    const vals = choices(l);
    const box = h('div', { class: 'taps', role: 'group', 'aria-label': `${l.name} on hand` });
    let other = null;
    // Full: at par, nothing to make. One tap, no counting (counted as the day's par).
    const par = l.dayPar ?? l.par;
    const isFull = () => par !== undefined && l.counted !== undefined && l.counted >= par;
    const draw = () => fill(box,
      par !== undefined && par > 0 ? h('button', { class: `tap full${isFull() ? ' on' : ''}`, 'aria-pressed': String(isFull()), title: `At par (${qty(par)}): nothing to make`, text: 'Full', onclick: async () => { l.counted = par; draw(); await save(par); } }) : null,
      (vals ?? []).map((v) => h('button', { class: `tap${l.counted === v && !isFull() ? ' on' : ''}`, 'aria-pressed': String(l.counted === v), text: v === 0 ? '0' : nice(v), onclick: async () => { l.counted = v; draw(); await save(v); } })),
      other ?? h('button', { class: `tap other${l.counted !== undefined && !(vals ?? []).includes(l.counted) ? ' on' : ''}`, text: l.counted !== undefined && !(vals ?? []).includes(l.counted) ? nice(l.counted) : 'other', onclick: () => {
        other = stepper(l.counted, 0.5, async (v) => { l.counted = v ?? undefined; await save(v); }, `${l.name} on hand`); draw(); other.querySelector('input')?.focus();
      } }));
    if (!vals) other = stepper(l.counted, 1, async (v) => { l.counted = v ?? undefined; await save(v); }, `${l.name} on hand`);
    draw();
    return box;
  };
  const rows = countable.map((l) => {
    const isBatch = l.kind === 'batch';
    const need = h('span', { class: 'small muted nowrap', text: l.toMake !== undefined ? `make ${amountWithWeight(l.toMake, l.unit, l)}` : '' });
    // Quick corrections (tap 3, then 2): one save at a time per line, and the last tap is what's sent, so a
    // slow first save can't land after the fix and put back the wrong count.
    let sending = null, latest;
    const save = async (val) => {
      l.counted = val === null ? undefined : val;
      tally();
      latest = { val };
      if (sending) return sending;
      sending = pageAction(async () => {
        while (latest) {
          const { val: v } = latest; latest = undefined;
          const res = await api('POST', `/api/prep/${stationId}/${date}/count`, { itemId: l.id, counted: v });
          if (latest) continue;
          if (res.ok) { const nl = res.data.lines.find((x) => x.id === l.id); need.textContent = nl?.toMake !== undefined ? `make ${amountWithWeight(nl.toMake, nl.unit, nl)}` : ''; }
          else need.textContent = res.data.error ?? 'Not saved';
        }
      }).finally(() => { sending = null; });
      return sending;
    };
    if (!isBatch) return h('div', { class: 'countrow tapped' },
      h('div', { class: 'row tight wrap' },
        h('div', { class: 'grow' }, h('div', { class: 'name', text: l.name }), h('div', { class: 'small muted', text: [l.unit ?? '', eachWeight(l), l.dayPar !== undefined ? `par ${qty(l.dayPar)}` : '', l.note ?? ''].filter(Boolean).join(' · ') })),
        l.estimate !== undefined ? h('span', { class: 'estimate small', title: 'Last count, plus what was made, minus what sold since. Count it anyway: this is a guess.', text: `my estimate: about ${nice(l.estimate) === '0' ? '0' : nice(l.estimate)}` }) : null,
        need),
      tapCount(l, need, save));
    return h('div', { class: 'countrow' },
      h('div', { class: 'grow' }, h('div', { class: 'name', text: l.name }), h('div', { class: 'small muted', text: isBatch
        ? (l.bulkUnit ? `Optional: on hand in ${l.bulkUnit}. ${l.onHand ? `The app has ${l.onHand.estimated ? 'about ' : ''}${qty(l.onHand.amount)} ${l.bulkUnit}.` : 'Nothing recorded yet.'}` : 'Set its storage unit under Edit list to track it.')
        : [l.unit ?? '', eachWeight(l), l.dayPar !== undefined ? `par ${qty(l.dayPar)}` : '', l.note ?? ''].filter(Boolean).join(' · ') })),
      isBatch ? h('span') : need,
      isBatch && !l.bulkUnit ? h('span') : stepper(l.counted, 0.5, save, `${l.name} on hand`));
  });
  const left = countable.filter((l) => l.counted === undefined && (l.kind === 'count' || l.bulkUnit));
  show(shell(me, 'prep', [
    prepHeader(me, v, 'Count', v.status === 'approved' ? 'Already approved for tomorrow. A chef can reopen it to change counts.' : 'How much is left of each, in the station’s units.'),
    page(h('section', { class: 'card' }, h('div', { class: 'list' }, rows),
      // The end of the list has its own way out, so nobody scrolls back up to finish.
      h('div', { class: 'row wrap count-end' }, endTally, h('div', { class: 'grow' }), h('button', { class: 'btn dark', text: 'Done counting', onclick: () => prepHome(me) }))), [
      sideBox('Counted', tallyBar, tallyText,
        sideActions(h('button', { class: 'btn dark', text: 'Done counting', onclick: () => prepHome(me) }))),
      left.length && left.length < toCount ? sideBox('Not counted yet', h('div', { class: 'small', text: left.map((l) => l.name).join(' · ') })) : null,
      sideBox('Tips', h('div', { class: 'small muted', text: 'Counts save as you go. Full means it’s at par: nothing to make, no need to count it. Bulk items are optional: count them when you know, and the suggestion for what fills from them gets sharper.' })),
    ], { sticky: true }),
  ]));
}

/** A small ? that opens a box with the reasoning (tap on the iPad, hover with a mouse). Chef's screens only. */
function whyTip(text, opts = {}) {
  if (!text) return null;
  const wrap = h('span', { class: `why-wrap${opts.wrapClass ? ` ${opts.wrapClass}` : ''}` });
  const btn = h('button', { class: opts.class ?? 'why', type: 'button', text: opts.label ?? '?', 'aria-label': opts.aria ?? 'Why this number', 'aria-expanded': 'false', onclick: (e) => {
    e.stopPropagation();
    const open = !wrap.classList.contains('open');
    document.querySelectorAll('.why-wrap.open').forEach((w) => { w.classList.remove('open'); w.firstChild.setAttribute('aria-expanded', 'false'); });
    wrap.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
  } });
  wrap.append(btn, h('span', { class: 'why-pop', role: 'tooltip', text }));
  return wrap;
}
document.addEventListener('click', (e) => { if (!e.target.closest?.('.why-wrap')) document.querySelectorAll('.why-wrap.open').forEach((w) => w.classList.remove('open')); });

// The chef's review: suggestions with reasons, any number can change, then approve.
async function prepReview(me, stationId, date) {
  const r = await api('GET', `/api/prep/${stationId}/${date}`);
  if (!r.ok) return show(shell(me, 'prep', [h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const v = r.data;
  const again = () => refreshInPlace(() => prepReview(me, stationId, date));
  const make = (l, val) => api('POST', `/api/prep/${stationId}/${date}/make`, { itemId: l.id, toMake: val });
  const uncounted = v.lines.filter((l) => l.kind === 'count' && l.counted === undefined);
  const rows = v.lines.map((l) => {
    const total = h('span', { class: 'small muted nowrap review-weight', text: weightOf(l.toMake, l).trim() });
    if (l.kind === 'task') return h('div', { class: 'reviewrow' }, h('div', { class: 'grow' }, h('div', { class: 'name', text: l.name }), h('div', { class: 'small muted', text: 'Daily task' })));
    const info = l.kind === 'batch'
      ? l.reason ?? (l.onHand && l.bulkUnit ? `${l.onHand.estimated ? 'About ' : ''}${qty(l.onHand.amount)} ${l.bulkUnit} on hand. Link the station items it fills (Edit list) for a suggestion.` : 'Bulk, made as needed: set its unit and batch size and link the station items it fills (Edit list) for a suggestion. Leave empty to skip.')
      : l.counted === undefined ? `Par ${qty(l.dayPar)} · not counted` : l.reason ?? '';
    const changed = l.chosen !== undefined && l.suggested !== undefined && l.chosen !== l.suggested;
    return h('div', { class: 'reviewrow' },
      h('div', { class: 'grow' }, h('div', { class: 'name', text: l.name }), h('div', { class: 'small muted', text: [l.unit ?? '', eachWeight(l), l.note ?? ''].filter(Boolean).join(' · ') }), h('div', { class: `small${changed ? ' changed' : ' muted'}` }, changed ? `${info} You changed it from ${qty(l.suggested)}.` : info,
        whyTip(l.parWhy ? `${l.parWhy}${l.counted !== undefined && l.suggested !== undefined ? ` ${qty(l.counted)} counted on hand, so make ${qty(l.suggested)}.` : ''}` : ''))),
      h('div', { class: 'small muted nowrap', text: 'Make' }),
      stepper(l.toMake, l.dayPar !== undefined && l.dayPar < 4 ? 0.5 : 1, async (val) => { total.textContent = weightOf(val, l).trim(); await make(l, val); }, `${l.name} to make`),
      total,
      changed ? h('button', { class: 'link', text: 'Use suggestion', onclick: async () => { await make(l, null); again(); } }) : null);
  });
  const approved = v.status === 'approved';
  const approve = h('button', { class: `btn ${approved ? '' : 'dark'}`, text: approved ? 'Reopen' : 'Approve', onclick: async () => {
      const res = await api('POST', `/api/prep/${stationId}/${date}/approve`, { approved: !approved });
      if (res.ok) again();
    } });
  const share = v.share !== undefined && v.share < 1 ? `${WEEKDAY[new Date(`${date}T12:00:00`).getDay()]} usually runs at ${Math.round(v.share * 100)}% of a ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][v.busiest]}, so pars are scaled to that. Items tied to a recipe follow their own dishes instead (the sauce follows the pizzas that use it). Tap ? on a line to see the math. ` : '';
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
    const res = await pageAction(() => api('POST', `/api/prep/${stationId}/${date}/done`, { itemId: l.id, state }));
    if (res.ok) return again();
    if (btn) { btn.classList.toggle('on', Boolean(l.doneAt)); btn.textContent = l.doneAt ? '✓' : ''; row?.classList.toggle('done', Boolean(l.doneAt)); btn.disabled = false; }
    row?.append(h('div', { class: 'error small', text: res.data.error ?? 'That didn’t save.' }));
  };
  const rows = work.map((l) => h('div', { class: `workrow${l.doneAt ? ' done' : ''}` },
    h('button', { class: `check${l.doneAt ? ' on' : l.startedAt ? ' started' : ''}`, 'aria-label': l.doneAt ? `Undo ${l.name}` : `Mark ${l.name} done`, onclick: (e) => act(l, l.doneAt ? 'undo' : 'done', e.currentTarget) }, l.doneAt ? '✓' : ''),
    h('div', { class: 'grow' },
      h('div', { class: 'name', text: l.name }),
      h('div', { class: 'small', text: l.kind === 'task' ? 'Daily' : `Make ${amountWithWeight(l.toMake, l.unit, l)}${l.note ? ` · ${l.note}` : ''}` }),
      h('div', { class: 'small muted', text: l.doneAt ? `Done by ${l.doneBy ?? ''} at ${timeOf(l.doneAt)}` : l.startedAt ? `Started by ${l.startedBy ?? ''} at ${timeOf(l.startedAt)}` : '' })),
    l.recipeName ? h('button', { class: 'btn', text: 'Recipe', onclick: () => recipeSheet(me, l.recipeName, { amount: l.toMake, unit: l.unit, ...(l.unitWeight && l.unitWeight.source !== 'unit' ? { grams: l.toMake * l.unitWeight.grams } : {}) }) }) : null,
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
  // Every save is a page action, so a refresh can't land mid-way and put back what was just changed.
  const post = (path, body) => pageAction(async () => { const res = await api('POST', path, body); if (!res.ok) alertLine.textContent = res.data.error ?? 'Not saved'; return res; });
  const save = async (path, body) => (await post(path, body)).ok;
  const alertLine = h('div', { class: 'error', role: 'alert' });
  // One step up or down from wherever it is now on the server, so quick taps each count.
  const move = async (list, i, dir, key) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    if (await save(`/api/prep/${stationId}/order`, { move: { id: list[i].id, by: dir, list: key } })) again();
  };
  const itemRow = (it, i) => {
    const name = h('input', { type: 'text', value: it.name, 'aria-label': 'Item name' });
    const unit = h('input', { type: 'text', value: it.unit ?? '', placeholder: 'unit', class: 'unit-in', 'aria-label': 'Unit', list: 'container-names' });
    const par = h('input', { inputmode: 'decimal', class: 'amount', value: it.par ?? '', placeholder: 'par', 'aria-label': 'Par' });
    const kind = h('select', { 'aria-label': 'Kind' }, [['count', 'Count'], ['task', 'Daily task'], ['batch', 'Bulk, as needed']].map(([k, t]) => h('option', { value: k, text: t, selected: it.kind === k ? true : undefined })));
    const days = it.weekdays ?? [];
    // Each tap turns its own day on or off, and the chip changes right away; quick taps on Mon then Tue both stick.
    const dayChips = h('div', { class: 'row tight wrap' }, WEEKDAY.map((d, n) => {
      const chip = h('button', { class: `lchip${days.includes(n) ? ' on' : ''}`, 'aria-pressed': days.includes(n) ? 'true' : 'false', text: d, onclick: async () => {
        const on = chip.getAttribute('aria-pressed') !== 'true';
        const paint = (v) => { chip.classList.toggle('on', v); chip.setAttribute('aria-pressed', v ? 'true' : 'false'); };
        paint(on);
        const res = await post(`/api/prep/items/${it.id}`, on ? { weekdayOn: n } : { weekdayOff: n });
        if (!res.ok) return paint(!on);
        it.weekdays = res.data.weekdays ?? null;
        again();
      } });
      return chip;
    }));
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
    // The bulk item's unit right after the amount, so it's clear what the number counts. If the bulk item
    // has no unit yet, it can be set here (it's saved on the bulk item).
    const sourceUnit = () => {
      if (sourceItem?.bulk_unit) return h('b', { class: 'small', text: sourceItem.bulk_unit, title: `${sourceItem.name} is kept in ${sourceItem.bulk_unit}` });
      if (!sourceItem) return null;
      const u = h('input', { type: 'text', class: 'unit-in', placeholder: 'qt, lb…', 'aria-label': `${sourceItem.name} is kept in` });
      u.addEventListener('change', async () => { if (u.value.trim() && await save(`/api/prep/items/${sourceItem.id}`, { bulkUnit: u.value })) again(); });
      return h('span', { class: 'row tight' }, u, h('span', { class: 'small muted', text: `(${sourceItem.name}’s unit)` }));
    };
    const base = (n) => n.replace(/\(.*?\)/g, '').trim().toLowerCase().replace(/s$/, '');
    const likely = !it.sourceItemId && others.find((b) => base(b.name) === base(it.name));
    const link = it.kind === 'count' && others.length ? h('div', { class: 'row tight wrap' }, h('span', { class: 'small muted', text: 'Filled from' }), source,
      likely ? h('button', { class: 'btn small-btn blue', text: `Link to ${likely.name}?`, onclick: async () => { if (await save(`/api/prep/items/${it.id}`, { sourceItemId: likely.id })) again(); } }) : null,
      it.sourceItemId ? h('span', { class: 'row tight' }, h('span', { class: 'small muted', text: `one ${it.unit ?? 'container'} holds` }), holds, sourceUnit()) : null) : null;
    // What one of it weighs: weighed on the scale (best), else what the recipe says. Weight keeps everyone honest.
    const wUnit = it.unit;
    const weightRow = wUnit && it.kind !== 'task' && it.unitWeight?.source !== 'unit' && dimensionName(wUnit) !== 'mass' ? (() => {
      const w = it.unitWeight;
      const lbIn = h('input', { inputmode: 'decimal', class: 'amount', value: it.unitGrams ? String(Math.round((it.unitGrams / 453.59237) * 100) / 100) : '', placeholder: w ? String(Math.round((w.grams / 453.59237) * 100) / 100) : '?', 'aria-label': `What one ${wUnit} of ${it.name} weighs, in lb` });
      lbIn.addEventListener('change', async () => {
        const v = lbIn.value.trim();
        if (v !== '' && !(Number(v) > 0)) return (alertLine.textContent = 'A weight in lb, more than 0.');
        if (await save(`/api/prep/items/${it.id}`, { unitGrams: v === '' ? null : Number(v) * 453.59237 })) again();
      });
      const hint = it.unitGrams ? `weighed${w?.estimate ? `; the recipe says about ${weightText(w.estimate)}` : ''}`
        : w?.source === 'recipe' ? `about ${weightText(w.grams)} from the recipe: weigh a full one to be exact` : 'weigh a full one';
      return h('div', { class: 'row tight wrap' }, h('span', { class: 'small muted', text: `One ${wUnit} weighs` }), lbIn, h('span', { class: 'small muted', text: 'lb' }), h('span', { class: `small ${it.unitGrams ? '' : 'muted'}`, text: hint }));
    })() : null;
    // One line for what it is (name, unit, par, kind, order), one small line for the rest.
    return h('div', { class: 'editrow compact' },
      h('div', { class: 'edit-main' }, name, unit, par, kind,
        editTools(() => move(s.items, i, -1, 'items'), () => move(s.items, i, 1, 'items'), it.name, async () => { if (await save(`/api/prep/items/${it.id}`, { active: false })) again(); })),
      h('div', { class: 'edit-more' },
        h('div', { class: 'row tight' }, h('span', { class: 'small muted', text: days.length ? 'Only on' : 'Every day, or only' }), dayChips),
        recipeRow, weightRow, link, bulkFields, dated));
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
      h('datalist', { id: 'container-names' }, (s.containers ?? []).map((n) => h('option', { value: n }))),
      sideBox('Weights', h('div', { class: 'small muted', text: 'Each item’s unit can be a container (1/9 pan, deep 1/9 pan, deli quart…). Weigh a full one once and enter it: the lists then show the weight beside every amount. Until then, items with a recipe show what the recipe says.' }),
        h('div', { class: 'list compact' },
          h('div', {}, h('span', { class: 'grow', text: 'Weighed' }), h('b', { text: String(s.items.filter((it) => it.unitGrams).length) })),
          h('div', {}, h('span', { class: 'grow', text: 'From the recipe' }), h('b', { text: String(s.items.filter((it) => !it.unitGrams && it.unitWeight?.source === 'recipe').length) }))),
        sideActions(h('button', { class: 'btn small-btn', text: 'Containers and units', onclick: () => unitsScreen(me, () => prepEdit(me, stationId)) }))),
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
  // Sell online, right on each dish (managers, kitchen): which Square items are on the order page.
  const onlineRes = manager && side === 'kitchen' ? await api('GET', '/api/online/menu') : null;
  const onlineById = new Map((onlineRes?.ok ? onlineRes.data.items : []).map((x) => [x.itemId, x]));
  const sellSwitch = (x) => {
    const o = x.squareItemId ? onlineById.get(x.squareItemId) : undefined;
    if (!o) return null;
    const input = h('input', { type: 'checkbox', role: 'switch', checked: o.published ? true : undefined, 'aria-label': `Sell ${x.name} online` });
    const label = h('label', { class: 'sell-switch', title: o.published ? 'On the online order page' : 'Not sold online' }, input, h('span', { text: 'Sell online' }));
    input.addEventListener('change', async () => {
      input.disabled = true;
      label.querySelector('.error')?.remove();
      const res = await api('POST', `/api/online/items/${o.itemId}`, { published: input.checked });
      input.disabled = false;
      if (!res.ok) { input.checked = !input.checked; return label.append(h('span', { class: 'error small', text: res.data.error ?? 'Not saved.' })); }
      o.published = input.checked;
      label.title = o.published ? 'On the online order page' : 'Not sold online';
    });
    return label;
  };
  const since = (d) => (d <= m.from ? `before ${shortDate(m.from)}` : `since ${shortDate(d)}`);
  const baseOf = (section) => section.replace(/ add-ons$/, '');
  const sections = [...new Set(m.current.map((x) => baseOf(x.section)))];
  // When it came on: its real first sale from the order history, when it predates the 90 days the numbers cover.
  const monthYear = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  const onText = (x) => x.onBefore ? ((Date.now() - Date.parse(`${x.onBefore}T12:00:00`)) / 86_400_000 > 355 ? 'On over a year' : `On before ${monthYear(x.onBefore)}`)
    : x.onSince ? `On since ${dateWithYear(x.onSince)}` : `On ${since(x.since)}`;
  // "Needs card" opens a new card already named and linked to the button that sells it.
  const writeCard = async (x) => {
    const d = (await api('GET', `/api/cards?area=${side}`)).data;
    // A bar drink that's one thing it was bought as (a glass or bottle of wine, a beer): start from that.
    let suggested;
    if (side === 'bar' && x.pos) {
      const drafts = (await api('GET', '/api/cards/drafts')).data?.drafts ?? [];
      const dr = drafts.find((y) => y.shape !== 'ownCard' && y.ingredients?.length && y.items.some((it) => it.catalogId === x.pos.catalogId));
      if (dr) suggested = { ingredients: dr.ingredients.map((i) => ({ ...i })), note: `Suggested from your invoices: ${dr.ingredients.map((i) => `${qty(i.amount)} ${UNIT_LABEL(i.unit)} of ${i.name}`).join(', ')}. Check it, then Mark ready.` };
    }
    cardEditor(me, d, null, { name: x.pos?.itemName ?? x.name, kind: side === 'bar' ? 'drink' : 'dish', link: x.pos ? [{ ...x.pos, name: x.name }] : [], ...(suggested ?? {}), back: returnTo('Menu', () => menuScreen(me)) });
  };
  // Any change saves, then the page comes back with fresh numbers (staying on the same chip).
  // The spinner stays on the button until it's saved; then that line folds away and the page refreshes where it is.
  const save = (el, path, body, row) => pageAction(async () => {
    pressed = null;
    busy(el, true);
    const res = await api('POST', path, body);
    if (!res.ok) { busy(el, false); return (row ?? el.parentNode).append(h('div', { class: 'error small', text: res.data.error ?? 'Not saved.' })); }
    await foldAway(row === undefined ? el.closest('.ask, .mline, .list > div') : row);
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
    const what = side === 'bar' ? 'drink' : 'dish';
    const pick = h('select', { class: 'small-select', 'aria-label': `${x.name} is the same ${what} as`, title: `A discount button for the same ${what} (a special price): its sales count with the other` }, h('option', { value: '', text: `Same ${what} as…` }), sib.map((o) => h('option', { value: o.pos.catalogId, text: o.name })));
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
      h('button', { class: 'link', text: 'Cancel', onclick: () => fill(actions, cells(x, row, actions)) }));
    actions.querySelector('.btn')?.focus();
  };
  const flagCards = m.cards;
  // A line: the dish (with its tags and when it came on), then plates a day, food cost, last sold, and Take off.
  const pctText = (v) => `${Math.round(v * 100)}%`;
  const cells = (x, row, right) => [
    h('span', { class: 'mcell', text: x.perDay !== undefined ? `${x.perDay}/day` : '–' }),
    (() => {
      const high = x.foodCost !== undefined && x.sectionFoodCost !== undefined && x.foodCost > x.sectionFoodCost + 0.05;
      return h('span', { class: `mcell${high ? ' warn-text strong' : ''}`, title: x.foodCost !== undefined ? `${pctText(x.foodCost)} of what it brought in${x.sectionFoodCost !== undefined ? `; ${x.section} runs ${pctText(x.sectionFoodCost)}` : ''}${x.costEstimated ? '. Some prices are estimates' : ''}` : 'No recipe cost yet', text: x.foodCost !== undefined ? `${pctText(x.foodCost)}${x.costEstimated ? '*' : ''}` : '–' });
    })(),
    h('span', { class: 'mcell c-last', text: x.lastSold ? shortDate(x.lastSold) : '–' }),
    h('span', { class: 'mcell c-act' }, manager && x.menuKey ? h('button', { class: 'link take-off', text: 'Take off', title: `Take ${x.name} off the menu`, onclick: () => takeOff(x, row, right) }) : null)];
  const dishRow = (x) => {
    const right = h('div', { class: 'mright' });
    const row = h('div', { class: 'mline' }, photo(x.image, 'thumb small') ?? h('span'),
      h('div', { class: 'mname' },
        h('div', { class: 'row tight wrap' }, h('span', { text: x.name }),
          x.quiet ? h('button', { class: 'tag ask tag-button', text: 'quiet', title: `Hasn’t sold since ${shortDate(x.quiet.since)}: still on?`, onclick: () => pickChip('needs') }) : null,
          x.hasCard || !flagCards ? null : h('button', { class: 'tag warn tag-button', text: 'needs recipe', title: `Write the recipe for ${x.name}`, onclick: () => writeCard(x) }),
          x.rough && flagCards ? h('button', { class: 'tag rough tag-button', text: 'rough', title: `${x.name}: the recipe is still being worked out`, onclick: () => recipePage(me, x.name, { from: returnTo('Menu', () => menuScreen(me)) }) }) : null,
          sameAs(x)),
        includesLine(x),
        h('div', { class: 'small muted', text: onText(x) }),
        sellSwitch(x)),
      right);
    fill(right, cells(x, row, right));
    return row;
  };
  // Column titles sort every section the same way; the choice is remembered on this device.
  let sortBy = (() => { try { return JSON.parse(recall('menuSort') ?? 'null') ?? { key: 'name', dir: 'asc' }; } catch { return { key: 'name', dir: 'asc' }; } })();
  const SORTS = { name: (x) => x.name, perDay: (x) => x.perDay, foodCost: (x) => x.foodCost, lastSold: (x) => x.lastSold };
  const sorted = (xs) => {
    const f = SORTS[sortBy.key] ?? SORTS.name, dir = sortBy.dir === 'asc' ? 1 : -1;
    return [...xs].sort((a, b) => { const p = f(a), q = f(b); if (p === undefined || q === undefined) return p === q ? 0 : p === undefined ? 1 : -1; return (typeof p === 'string' ? p.localeCompare(q) : p - q) * dir; });
  };
  const head = () => {
    const col = (key, label, cls = '') => {
      const on = sortBy.key === key;
      return h('button', { class: `sort mcell ${cls}${on ? ' on' : ''}`, 'aria-sort': on ? (sortBy.dir === 'asc' ? 'ascending' : 'descending') : 'none',
        onclick: () => { sortBy = { key, dir: on ? (sortBy.dir === 'asc' ? 'desc' : 'asc') : key === 'name' ? 'asc' : 'desc' }; remember('menuSort', JSON.stringify(sortBy)); draw(); } },
        label, h('span', { class: 'arrow', text: on ? (sortBy.dir === 'asc' ? ' ▲' : ' ▼') : '' }));
    };
    return h('div', { class: 'mline mhead' }, h('span'), h('div', { class: 'mname' }, col('name', 'Dish', 'left')),
      h('div', { class: 'mright' }, col('perDay', 'Per day'), col('foodCost', side === 'bar' ? 'Pour cost' : 'Food cost'), col('lastSold', 'Last sold', 'c-last'), h('span', { class: 'mcell c-act' })));
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
      if (c.kind === 'newButton' && c.item) row.lastChild.append(otherCard(row, c.item));
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
  const canOnline = manager && side === 'kitchen';
  const valid = (k) => k === 'needs' ? needCount > 0 : k === 'coming' ? canPlan : k === 'online' || k === 'windows' ? canOnline : sections.includes(k);
  let chip = recall(chipKey);
  if (!valid(chip)) chip = needCount ? 'needs' : sections[0] ?? (canPlan ? 'coming' : 'needs');
  let coming = null, online = null, windows = null, orderPage = null;
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
      canPlan ? h('button', { class: `chip${chip === 'coming' ? ' on' : ''}`, role: 'tab', 'aria-selected': String(chip === 'coming'), onclick: () => pickChip('coming') }, 'Coming up') : null,
      // Online's settings (the order page, pickup windows) open from a button on it, under the same chip.
      canOnline ? h('button', { class: `chip${chip === 'online' || chip === 'windows' ? ' on' : ''}`, role: 'tab', 'aria-selected': String(chip === 'online' || chip === 'windows'), onclick: () => pickChip('online') }, 'Online') : null);
    let main;
    if (chip === 'needs') {
      main = [quietCard, questionRows.length ? h('section', { class: 'card', id: 'menu-questions' },
        h('div', { class: 'row' }, h('h2', { class: 'grow', text: `About what’s selling (${questionRows.length})` }), h('span', { class: 'small muted', text: 'Answers update margins straight away.' })),
        h('div', { class: 'asks' }, questionRows)) : null];
      if (!quietCard && !questionRows.length) main = [h('section', { class: 'card small muted', text: 'Nothing needs you.' })];
    } else if (chip === 'online') {
      online ??= await onlineMenuCard(me, () => pickChip('windows'));
      main = [online];
    } else if (chip === 'windows') {
      windows ??= await pickupWindowsCard(me);
      orderPage ??= await orderPageCard();
      main = [h('div', { class: 'row online-settings-head' }, h('button', { class: 'btn small-btn', text: '← Items sold online', onclick: () => pickChip('online') }), h('h2', { class: 'grow', text: 'Online settings' })), orderPage, windows];
    } else if (chip === 'coming') {
      coming ??= await comingUpCard(me);
      main = [coming ?? h('section', { class: 'card small muted', text: 'Couldn’t load what’s coming up.' })];
    } else {
      const parts = [...new Set(m.current.filter((x) => baseOf(x.section) === chip).map((x) => x.section))];
      main = parts.map((sec) => h('section', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { class: 'grow', text: sec }), h('span', { class: 'small muted', text: String(m.current.filter((x) => x.section === sec).length) })),
        h('div', { class: 'mlist' }, head(), sorted(m.current.filter((x) => x.section === sec)).map((x) => dishRow(x)))));
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

// ------------------------------------------------------------------ online ordering

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const clock = (hhmm) => { const [hh, mm] = hhmm.split(':').map(Number); return `${hh % 12 || 12}:${String(mm).padStart(2, '0')}`; };
/**
 * Drag to reorder: the `selector` children of `box` move by their .drag-handle, with a mouse, a
 * finger or the arrow keys. `onDrop` runs after anything moved. Lists can nest: a handle moves only
 * its own row.
 */
function sortable(box, selector, onDrop) {
  const rows = () => [...box.children].filter((k) => k.matches(selector));
  const rowOf = (target) => {
    const handle = target.closest('.drag-handle');
    const row = handle?.closest(selector);
    return row && row.parentNode === box && handle.closest('[data-key]') === row ? { handle, row } : null;
  };
  box.addEventListener('pointerdown', (e) => {
    const hit = rowOf(e.target);
    if (!hit) return;
    const { handle, row } = hit;
    e.preventDefault();
    e.stopPropagation();
    row.classList.add('dragging');
    const start = rows().indexOf(row);
    // On the document, not the handle: moving the row in the page would drop a capture on the handle.
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      ev.preventDefault();
      const others = rows().filter((k) => k !== row);
      const before = others.find((k) => { const r = k.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
      if (before) { if (row.nextElementSibling !== before) box.insertBefore(row, before); }
      else if (others.length && rows().at(-1) !== row) others.at(-1).after(row);
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      row.classList.remove('dragging');
      if (rows().indexOf(row) !== start) onDrop();
    };
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  });
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const hit = rowOf(e.target);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    const list = rows();
    const i = list.indexOf(hit.row);
    const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
    if (j < 0 || j >= list.length) return;
    if (j < i) list[j].before(hit.row); else list[j].after(hit.row);
    hit.handle.focus();
    onDrop();
  });
}
const dragHandle = (label) => h('button', { type: 'button', class: 'drag-handle', 'aria-label': label, title: 'Drag, or use the arrow keys', text: '⠿' });

const MODE_LABELS = { shown: 'Shown', hidden: 'Hidden online', always: 'Always on' };

/**
 * What's sold online: the items on the order page, each with Counts as a pizza, Pause online tonight and
 * how its options show online. Search (or Browse) the Square library to add one; most get turned on
 * from the Menu screen's Sell online switch. Arrange shows the order page's sections and items to
 * drag into the order customers see, with how many of each sold lately. Options are shared across items in Square, so a change
 * to one changes it everywhere it's used.
 */
async function onlineMenuCard(me, openSettings) {
  const box = h('section', { class: 'card', 'aria-label': 'Sold online' });
  const open = new Set();
  let items = [];
  let browsing = false;
  let arranging = false;
  const err = h('div', { class: 'error small' });
  const list = h('div', { class: 'stack' });
  const results = h('div', { class: 'asks' });
  const search = h('input', { type: 'search', placeholder: 'Find a Square item to add', 'aria-label': 'Find a Square item', autocomplete: 'off' });
  const browse = h('button', { class: 'btn small-btn', onclick: () => { browsing = !browsing; arranging = false; draw(); } });
  const arrange = h('button', { class: 'btn small-btn', onclick: () => { arranging = !arranging; browsing = false; draw(); } });
  search.addEventListener('input', () => found());
  const save = (el, path, body) => pageAction(async () => {
    err.textContent = '';
    const res = await api('POST', path, body);
    if (!res.ok) { err.textContent = res.data.error ?? 'Not saved.'; return; }
    await load();
  });
  const price = (x) => x.variations.map((v) => (v.price !== undefined ? `${x.variations.length > 1 ? `${v.name} ` : ''}${dollars(v.price, { cents: v.price % 1 !== 0 })}` : null)).filter(Boolean).join(' · ');
  const options = (x) => h('div', { class: 'stack' }, x.modifierLists.map((l) => h('div', { class: 'small' },
    h('div', { class: 'strong', text: `${l.name}${l.min ? ' (required)' : ''}` }),
    l.modifiers.map((mod) => {
      const pick = h('select', { class: 'small-select', 'aria-label': `${mod.name} online`, disabled: mod.locked, title: mod.locked ? 'Its name in Square says it’s not available online' : undefined }, ['shown', 'hidden', 'always'].map((k) => h('option', { value: k, text: MODE_LABELS[k], selected: mod.mode === k ? true : undefined })));
      pick.addEventListener('change', () => save(pick, `/api/online/modifiers/${mod.id}`, { mode: pick.value }));
      return h('div', { class: 'row tight wrap' }, pick, h('span', { text: mod.name }), mod.price ? h('span', { class: 'muted', text: `+${dollars(mod.price, { cents: true })}` }) : null,
        mod.byDefault && mod.mode === 'shown' ? h('span', { class: 'tag', text: 'Pre-selected', title: 'On by default in Square, so it starts ticked on the order page' }) : null,
        mod.soldOut ? h('span', { class: 'tag bad', text: 'Unavailable in Square', title: 'As of the last Square sync. The order page checks Square every minute.' }) : null);
    }))));
  const nameOf = (x) => h('span', { class: 'grow' }, h('b', { text: x.name }), h('span', { class: 'small muted', text: price(x) ? ` · ${price(x)}` : '' }));
  // An item that's online: everything about how it sells.
  const onlineRow = (x) => {
    const pizza = h('input', { type: 'checkbox', checked: x.countsAsPizza ? true : undefined, 'aria-label': `${x.name} counts as a pizza` });
    pizza.addEventListener('change', () => save(pizza, `/api/online/items/${x.itemId}`, { countsAsPizza: pizza.checked }));
    const showOptions = x.modifierLists.length ? h('button', { class: 'link', text: open.has(x.itemId) ? 'Hide options' : `Options (${x.modifierLists.length})`, onclick: () => { open.has(x.itemId) ? open.delete(x.itemId) : open.add(x.itemId); draw(); } }) : null;
    return h('div', { class: 'ask' },
      h('div', { class: 'row wrap' },
        photo(x.image, 'thumb small'), nameOf(x),
        x.soldOutToday ? h('span', { class: 'tag bad', text: 'Paused online tonight', title: 'Off the online order page only. Square and the POS still sell it.' }) : null,
        x.soldOutInSquare ? h('span', { class: 'tag bad', text: 'Sold out in Square', title: 'As of the last Square sync. The order page checks Square every minute.' }) : null,
        // Only the online order page: staff looking to 86 an item everywhere need Square.
        h('button', { class: 'btn small-btn', text: x.soldOutToday ? 'Back on online' : 'Pause online tonight',
          title: x.soldOutToday ? `Put ${x.name} back on the online order page` : `Takes ${x.name} off the online order page until tomorrow. It does NOT 86 it in Square or the POS: mark it sold out in Square for that.`, onclick: (e) => save(e.currentTarget, `/api/online/items/${x.itemId}`, { soldOutToday: !x.soldOutToday }) }),
        h('label', { class: 'inline small', title: x.pizzaFromCategory ? `From its category, ${x.category}` : 'Set by hand' }, pizza, 'Counts as a pizza'),
        showOptions,
        h('button', { class: 'link', text: 'Take off', title: `Stop selling ${x.name} online`, onclick: (e) => save(e.currentTarget, `/api/online/items/${x.itemId}`, { published: false }) })),
      x.problems.map((p) => h('div', { class: 'tag warn', text: p })),
      open.has(x.itemId) ? options(x) : null);
  };
  // An item from the library: add it, or it says it's online already.
  const libraryRow = (x) => h('div', { class: 'ask' }, h('div', { class: 'row wrap' },
    photo(x.image, 'thumb small'), nameOf(x), h('span', { class: 'small muted', text: x.category }),
    x.published ? h('span', { class: 'tag', text: 'Online' })
      : h('button', { class: 'btn small-btn dark', text: 'Add', 'aria-label': `Sell ${x.name} online`, onclick: (e) => save(e.currentTarget, `/api/online/items/${x.itemId}`, { published: true }) })));
  function found() {
    const q = search.value.trim().toLowerCase();
    if (!q) return fill(results);
    const words = q.split(/\s+/);
    const hits = items.filter((x) => words.every((w) => `${x.name} ${x.category}`.toLowerCase().includes(w)))
      .sort((a, b) => Number(a.published) - Number(b.published) || a.name.localeCompare(b.name)).slice(0, 20);
    fill(results, hits.length ? hits.map(libraryRow) : h('div', { class: 'small muted', text: 'No Square item by that name.' }));
  }
  const folded = new Set();
  // The order page as customers see it: drag sections and items, saved as they drop.
  function arrangeView(online) {
    const saveOrder = async () => {
      err.textContent = '';
      const res = await api('POST', '/api/online/arrange', {
        categories: [...view.querySelectorAll('.arr-cat')].map((c) => c.dataset.key),
        items: [...view.querySelectorAll('.arr-item')].map((i) => i.dataset.key),
      });
      if (!res.ok) { err.textContent = res.data.error ?? 'The new order didn’t save.'; return load(); }
      const again = await api('GET', '/api/online/menu');
      if (again.ok) items = again.data.items;
    };
    const itemRow = (x) => h('div', { class: 'arr-item', 'data-key': x.itemId, 'data-sold': x.sold30 },
      dragHandle(`Move ${x.name}`), photo(x.image, 'thumb small') ?? h('span'),
      h('span', { class: 'grow' }, h('b', { text: x.name }), h('span', { class: 'small muted', text: price(x) ? ` · ${price(x)}` : '' })),
      h('span', { class: 'small muted nowrap', text: `${x.sold30} sold in 30 days` }));
    const section = (cat) => {
      const rows = h('div', { class: 'arr-items' }, online.filter((x) => x.category === cat).map(itemRow));
      sortable(rows, '.arr-item', saveOrder);
      const box = h('div', { class: 'arr-cat', 'data-key': cat });
      const toggle = h('button', { type: 'button', class: 'arr-fold', onclick: () => fold(box, !box.classList.contains('folded')) });
      box.append(h('div', { class: 'arr-cat-head' }, dragHandle(`Move ${cat}`), h('h3', { text: cat }), toggle), rows);
      fold(box, folded.has(cat));
      return box;
    };
    const fold = (box, shut) => {
      const n = box.querySelectorAll('.arr-item').length;
      box.classList.toggle('folded', shut);
      shut ? folded.add(box.dataset.key) : folded.delete(box.dataset.key);
      const toggle = box.querySelector('.arr-fold');
      toggle.textContent = shut ? `▸ Show ${n} item${n === 1 ? '' : 's'}` : '▾ Collapse';
      toggle.setAttribute('aria-expanded', String(!shut));
      if (view) foldAll.textContent = view.querySelector('.arr-cat:not(.folded)') ? 'Collapse all' : 'Expand all';
    };
    let view = null;
    const foldAll = h('button', { class: 'btn small-btn', title: 'Fold sections to their names, handy for moving whole sections',
      onclick: () => { const shut = !!view.querySelector('.arr-cat:not(.folded)'); view.querySelectorAll('.arr-cat').forEach((c) => fold(c, shut)); } });
    view = h('div', { class: 'arrange' }, [...new Set(online.map((x) => x.category))].map(section));
    foldAll.textContent = view.querySelector('.arr-cat:not(.folded)') ? 'Collapse all' : 'Expand all';
    sortable(view, '.arr-cat', saveOrder);
    const slowFirst = () => {
      for (const rows of view.querySelectorAll('.arr-items')) [...rows.children].sort((a, b) => Number(a.dataset.sold) - Number(b.dataset.sold)).forEach((k) => rows.append(k));
      saveOrder();
    };
    return h('div', { class: 'stack' },
      h('div', { class: 'small muted', text: 'Drag sections and items into the order customers see. It saves as you drop.' }),
      h('div', { class: 'row wrap' }, foldAll,
        h('button', { class: 'btn small-btn', text: 'Slowest sellers first', title: 'In each section, put the items that sold least in the last 30 days on top', onclick: slowFirst })),
      view);
  }
  const byCategory = (xs, row) => [...new Set(xs.map((x) => x.category))].map((cat) => [h('h3', { text: cat }), h('div', { class: 'asks' }, xs.filter((x) => x.category === cat).map(row))]);
  function draw() {
    const online = items.filter((x) => x.published);
    browse.textContent = browsing ? 'Hide the list' : 'Browse all';
    arrange.textContent = arranging ? 'Done arranging' : 'Arrange';
    if (arranging && online.length) return fill(list, arrangeView(online)), found();
    fill(list,
      browsing ? h('div', { class: 'stack' }, h('div', { class: 'small muted', text: `Every item in Square (${items.length})` }), byCategory(items, libraryRow)) : null,
      browsing ? null : online.length ? byCategory(online, onlineRow)
        : h('div', { class: 'small muted', text: 'Nothing is online yet. Turn on Sell online for a dish on the Menu, or find an item above.' }));
    box.querySelector('h2').textContent = `Sold online (${online.length})`;
    found();
  }
  async function load() {
    const r = await api('GET', '/api/online/menu');
    if (!r.ok) { err.textContent = r.data.error ?? 'Couldn’t load.'; return; }
    items = r.data.items;
    box.querySelector('.sync-warn').hidden = r.data.synced;
    draw();
  }
  fill(box,
    h('h2', { text: 'Sold online' }),
    h('div', { class: 'small muted', text: 'Names, prices and options come from Square. Under Options, set “Partially cooked” to Always on and hide fully cooked and gluten-sensitive crust: an option changes everywhere it’s used.' }),
    h('div', { class: 'small' }, h('b', { text: 'Pause online tonight' }), ' only takes an item off the online order page. To 86 it everywhere, mark it sold out in Square.'),
    h('div', { class: 'tag warn sync-warn', text: 'No Square menu yet: run the Square sync under Settings.', hidden: true }),
    h('div', { class: 'row tight online-find' }, search, browse, arrange, h('button', { class: 'btn small-btn', text: 'Settings', onclick: openSettings })),
    results, err, list);
  await load();
  return box;
}

/**
 * The order page's own content: a header photo across the top of the menu (optional; made small
 * enough to send here, long edge 2000 px, JPEG) and the notice in the dark box above the menu.
 */
async function orderPageCard() {
  const box = h('section', { class: 'card', 'aria-label': 'Order page' });
  const err = h('div', { class: 'error small' });
  let page = { headerImage: null, notice: '', noticeChanged: false, whyPartial: '', whyPartialChanged: false, glutenFree: '', glutenFreeChanged: false, defaultTip: 0 };
  const post = (b) => pageAction(async () => {
    err.textContent = '';
    const res = await api('POST', '/api/online/page', b);
    if (!res.ok) { err.textContent = res.data.error ?? 'Not saved.'; return; }
    page = res.data;
    draw();
  });
  function draw() {
    const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': 'Header photo file' });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      let photo;
      try { photo = await shrinkPhoto(f); } catch { err.textContent = 'That file isn’t a photo.'; return; }
      if (!photo.preview) { err.textContent = 'Use a JPEG, PNG or WebP photo.'; return; }
      await post({ headerImage: photo.preview });
    });
    // A box of words on the order page: saved on its own, and able to go back to the usual words.
    const words = (label, help, key, rows, max) => {
      const text = h('textarea', { rows: String(rows), maxlength: String(max), class: 'notice-text', 'aria-label': `${label} text` });
      text.value = page[key];
      return h('div', { class: 'stack' },
        h('label', { class: 'small strong', text: label }),
        h('div', { class: 'small muted', text: help }),
        text,
        h('div', { class: 'row tight wrap' },
          h('button', { class: 'btn small-btn dark', text: 'Save', onclick: () => post({ [key]: text.value }) }),
          page[`${key}Changed`] ? h('button', { class: 'link', text: 'Back to the usual words', onclick: () => post({ [key]: null }) }) : null));
    };
    fill(box,
      h('h2', { text: 'Order page' }),
      h('div', { class: 'small muted', text: 'The photo goes across the top of the online menu. A wide landscape photo works best.' }),
      h('div', { class: 'page-preview' },
        page.headerImage ? h('img', { src: page.headerImage, alt: 'Header photo' }) : h('div', { class: 'page-empty small muted', text: 'No header photo' })),
      h('div', { class: 'stack' },
        h('label', { class: 'small strong', text: page.headerImage ? 'Replace the header photo' : 'Header photo' }),
        h('div', { class: 'row tight wrap' }, file,
          page.headerImage ? h('button', { class: 'link', text: 'Remove photo', onclick: () => post({ headerImage: null }) }) : null)),
      words('Notice', 'The dark box above the menu and on the thank-you page. The first line is bold; leave a blank line before the smaller part underneath.', 'notice', 6, 600),
      words('Why partially cooked?', 'Opens from the “Why partially cooked?” button beside the menu sections. Leave a blank line between paragraphs; the finishing-at-home steps show under it.', 'whyPartial', 9, 2000),
      words('Do you have gluten-free?', 'Opens from the “Do you have gluten-free?” button beside the menu sections. Leave a blank line between paragraphs.', 'glutenFree', 6, 2000),
      h('div', { class: 'stack' },
        h('label', { class: 'small strong', text: 'Default tip' }),
        h('div', { class: 'small muted', text: 'Already picked when a customer reaches checkout. They can still change it.' }),
        h('div', { class: 'row tight wrap', role: 'group', 'aria-label': 'Default tip' }, [0, 10, 15, 20].map((p) =>
          h('button', { class: `btn small-btn${p === page.defaultTip ? ' dark' : ''}`, 'aria-pressed': String(p === page.defaultTip), text: p ? `${p}%` : 'No tip', onclick: () => p !== page.defaultTip && post({ defaultTip: p }) })))),
      err);
  }
  const r = await api('GET', '/api/online/page');
  if (r.ok) page = r.data; else err.textContent = r.data.error ?? 'Couldn’t load.';
  draw();
  return box;
}

/**
 * Pickup windows: how many pizzas each 15-minute window takes. Tonight (or any date) on top, changed
 * on its own; the weekly plan under it, a column per weekday. A date's numbers save as they're
 * typed; the weekly plan's wait for Save, so the grid doesn't redraw under the person filling it in.
 */
async function pickupWindowsCard(me) {
  const box = h('section', { class: 'stack', 'aria-label': 'Pickup windows' });
  let day = null;
  // Weekly plan edits not saved yet: "weekday|starts" → pizzas. Kept across redraws of the date card.
  const unsaved = new Map();
  async function draw() {
    const r = await api('GET', `/api/online/windows${day ? `?day=${day}` : ''}`);
    if (!r.ok) return fill(box, h('section', { class: 'card' }, h('h2', { text: 'Pickup windows' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })));
    const w = r.data;
    day = w.day;
    const err = h('div', { class: 'error small' });
    const post = (path, body) => pageAction(async () => {
      const res = await api('POST', path, body);
      if (!res.ok) { err.textContent = res.data.error ?? 'Not saved.'; return; }
      await draw();
    });
    const number = (value, label, onSave) => {
      const input = h('input', { class: 'amount', type: 'number', inputmode: 'numeric', min: '0', max: '99', step: '1', value: String(value), 'aria-label': label });
      input.addEventListener('change', () => {
        if (!input.value.trim()) { input.value = String(value); return; }
        const n = Number(input.value);
        if (!Number.isInteger(n) || n < 0 || n > 99) { err.textContent = 'A window takes 0 to 99 pizzas.'; input.value = String(value); return; }
        onSave(n);
      });
      return input;
    };

    // One date: its windows, each changed on its own, or the rest of the evening closed.
    const isToday = w.day === w.today;
    const dayPick = h('input', { type: 'date', min: w.today, value: w.day, 'aria-label': 'Date' });
    dayPick.addEventListener('change', () => { if (dayPick.value) { day = dayPick.value; draw(); } });
    const left = w.windows.filter((x) => x.max > 0 && (!isToday || x.starts > w.now));
    const closeFrom = h('select', { class: 'small-select', 'aria-label': 'Close online orders from' }, left.map((x) => h('option', { value: x.starts, text: `from ${clock(x.starts)}` })));
    const anyChanged = w.windows.some((x) => x.changed);
    const dayCard = h('section', { class: 'card' },
      h('div', { class: 'row wrap' }, h('h2', { class: 'grow', text: isToday ? 'Tonight' : longDay(w.day) }), dayPick),
      h('div', { class: 'small muted', text: 'Pizzas each window takes on this date. A change here is for this date only; the weekly plan stays as it is.' }),
      h('div', { class: 'wlist' }, w.windows.map((x) => h('div', { class: `wcell${isToday && x.starts <= w.now ? ' past' : ''}` },
        h('div', { class: 'small strong', text: `${clock(x.starts)}–${clock(x.ends)}` }),
        number(x.max, `${clock(x.starts)} window, pizzas`, (n) => post('/api/online/windows/day', { day: w.day, cells: [{ starts: x.starts, maxPizzas: n }] })),
        x.changed ? h('button', { class: 'link small', text: 'Use plan', title: 'Back to the weekly plan for this window', onclick: () => post('/api/online/windows/day', { day: w.day, cells: [{ starts: x.starts, maxPizzas: null }] }) }) : h('span', { class: 'small muted', text: 'plan' })))),
      h('div', { class: 'row wrap' },
        left.length ? [h('span', { class: 'small', text: 'Dine-in slammed?' }), closeFrom, h('button', { class: 'btn small-btn dark', text: 'Close online orders', onclick: () => {
          if (confirmText(`No more online orders ${isToday ? 'tonight' : `on ${shortDate(w.day)}`} from ${clock(closeFrom.value)}? Orders already placed stay.`)) post('/api/online/windows/day', { day: w.day, closeFrom: closeFrom.value });
        } })] : h('span', { class: 'small muted', text: 'No windows left tonight.' }),
        anyChanged ? h('button', { class: 'link', text: 'Back to the weekly plan', onclick: () => post('/api/online/windows/day', { day: w.day, reset: true }) }) : null),
      err);

    // The weekly plan: windows down the side, weekdays across. A blank weekday sells nothing online.
    const cell = (weekday, starts) => w.plan.find((c) => c.weekday === weekday && c.starts === starts)?.maxPizzas ?? 0;
    const order = [1, 2, 3, 4, 5, 6, 0];
    const key = (d, starts) => `${d}|${starts}`;
    for (const [k, n] of unsaved) { const [d, starts] = k.split('|'); if (cell(Number(d), starts) === n) unsaved.delete(k); }
    const inputs = new Map();
    const saveBtn = h('button', { class: 'btn small-btn dark', text: 'Save' });
    const discardBtn = h('button', { class: 'link', text: 'Discard changes' });
    const status = h('span', { class: 'small muted grow' });
    const showUnsaved = () => {
      for (const [k, input] of inputs) input.classList.toggle('dirty', unsaved.has(k));
      saveBtn.disabled = !unsaved.size;
      discardBtn.hidden = !unsaved.size;
      status.textContent = unsaved.size ? `${unsaved.size} change${unsaved.size === 1 ? '' : 's'} not saved yet` : 'All saved';
    };
    const edit = (d, starts, n) => {
      const k = key(d, starts);
      if (n === cell(d, starts)) unsaved.delete(k); else unsaved.set(k, n);
      inputs.get(k).value = String(n);
      showUnsaved();
    };
    const planErr = h('div', { class: 'error small' });
    saveBtn.addEventListener('click', () => pageAction(async () => {
      const cells = [...unsaved].map(([k, n]) => { const [d, starts] = k.split('|'); return { weekday: Number(d), starts, maxPizzas: n }; });
      if (!cells.length) return;
      saveBtn.disabled = true;
      const res = await api('POST', '/api/online/windows/plan', { cells });
      if (!res.ok) { planErr.textContent = res.data.error ?? 'Not saved.'; saveBtn.disabled = false; return; }
      unsaved.clear();
      await draw();
    }));
    discardBtn.addEventListener('click', () => { unsaved.clear(); draw(); });
    const planInput = (d, starts) => {
      const k = key(d, starts);
      const input = number(unsaved.get(k) ?? cell(d, starts), `${WEEKDAYS[d]} ${clock(starts)}, pizzas`, (n) => edit(d, starts, n));
      inputs.set(k, input);
      return input;
    };
    const grid = h('table', { class: 'wgrid' },
      h('thead', {}, h('tr', {}, h('th', { text: '' }), order.map((d) => h('th', { text: WEEKDAYS[d] })))),
      h('tbody', {},
        h('tr', { class: 'all' }, h('th', { class: 'small', text: 'Every window' }), order.map((d) => h('td', {},
          number('', `${WEEKDAYS[d]}, every window`, (n) => w.starts.forEach((starts) => edit(d, starts, n)))))),
        w.starts.map((starts) => h('tr', {}, h('th', { class: 'small', text: clock(starts) }), order.map((d) => h('td', {}, planInput(d, starts)))))));
    const planCard = h('section', { class: 'card' },
      h('h2', { text: 'Weekly plan' }),
      h('div', { class: 'small muted', text: 'Pizzas each 15-minute window takes, by weekday. Salads, gelato and drinks don’t count. An order goes in the first window with room for all its pizzas; 0 means no online orders in that window. Changes here wait for Save.' }),
      h('div', { class: 'wgrid-wrap' }, grid),
      h('div', { class: 'row wrap plan-save' }, status, discardBtn, saveBtn), planErr);
    showUnsaved();

    const changedCard = w.changedDays.length ? sideBox('Dates with their own limits', h('div', { class: 'list compact' }, w.changedDays.map((c) => h('div', {},
      h('button', { class: 'linkish grow', text: `${shortDate(c.day)}${c.note ? ` · ${c.note}` : ''}`, onclick: () => { day = c.day; draw(); } }),
      h('span', { class: 'small muted nowrap', text: c.closed ? 'closed online' : `${c.windows} window${c.windows === 1 ? '' : 's'} changed` }))))) : null;
    fill(box, dayCard, planCard, changedCard);
  }
  await draw();
  return box;
}

// ------------------------------------------------------------------ recipe book

/** The book: Kitchen | Bar, then sections (what sells most first, preps last), then cards. */
// ---------------------------------------------------------------- Recipes: the book, as one tree
//
// Managers: a home that only lists what needs a look (a clean book is a clean page), then a tree from
// the menu down through preps to each ingredient, with a cost chart at every step and markers that
// roll up (a marker on a dish is somewhere under it). Cooks: today's list, and a search for the rest.

const MARKERS = [
  ['notBought', '', 'ingredient not bought', 'Ingredient not bought: the recipe may name a product you’ve stopped buying'],
  ['noCost', '✕', 'no cost', 'No cost: a line with no price, or a unit that won’t convert'],
  ['red', '●', 'old price', 'A price over 6 months old, or MarginEdge’s last price'],
  ['yellow', '●', 'price getting old', 'A price over 3 months old'],
  ['rough', '✎', 'rough', 'Rough: not marked ready, so cooks don’t see it'],
];
const hasMarks = (m) => Boolean(m && MARKERS.some(([k]) => m[k]?.length));
/** Small chips for what's wrong under something: "ingredient not bought", "✕ 2 no cost". */
function markerChips(m, max = 3) {
  if (!m) return null;
  const chips = MARKERS.filter(([k]) => m[k]?.length).slice(0, max).map(([k, icon, label]) =>
    h('span', { class: `mk mk-${k}`, title: `${label}: ${m[k].join(', ')}` }, `${icon ? `${icon} ` : ''}${m[k].length > 1 ? `${m[k].length} ` : ''}${label}`));
  return chips.length ? h('div', { class: 'mks' }, chips) : null;
}
/** A year of cost as a small line: no axes, the last point marked. */
function costSpark(vals) {
  if (!vals?.length) return h('span');
  const W = 84, H = 22, lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const pts = vals.map((v, i) => [(i / Math.max(1, vals.length - 1)) * (W - 4) + 2, H - 3 - ((v - lo) / span) * (H - 6)]);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'spark'); svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(ns, 'polyline'); line.setAttribute('points', pts.map((p) => p.join(',')).join(' ')); svg.append(line);
  const dot = document.createElementNS(ns, 'circle'); dot.setAttribute('cx', pts.at(-1)[0]); dot.setAttribute('cy', pts.at(-1)[1]); dot.setAttribute('r', '2.5'); svg.append(dot);
  return svg;
}
/** Change over the last 90 days of a sparkline (a point every 4 weeks): up is red (costs more). */
function sparkChange(vals) {
  if (!vals?.length) return h('span');
  const a = vals.at(-4) ?? vals[0], z = vals.at(-1), c = a ? (z - a) / a : 0;
  if (Math.abs(c) < 0.01) return h('span', { class: 'small muted', text: 'steady' });
  return h('span', { class: c > 0 ? 'up-bad' : 'down-good', text: `${c > 0 ? '▲' : '▼'} ${Math.round(Math.abs(c) * 100)}%` });
}
/** What a recipe cost each week for a year: one line, a dot today, and a readout under the finger. */
function costChart(points, label) {
  const ns = 'http://www.w3.org/2000/svg';
  const W = 720, H = 210, L = 56, R = 72, T = 14, B = 30;
  const vals = points.map((p) => p.cost), lo = Math.min(...vals), hi = Math.max(...vals), pad = Math.max((hi - lo) * 0.25, hi * 0.04, 0.01);
  const y0 = Math.max(0, lo - pad), y1 = hi + pad;
  const x = (i) => L + (i / Math.max(1, points.length - 1)) * (W - L - R), y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const el = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e; };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label, class: 'cost-chart' });
  for (const t of [y0 + (y1 - y0) * 0.1, (y0 + y1) / 2, y1 - (y1 - y0) * 0.1]) {
    svg.append(el('line', { x1: L, x2: W - R, y1: y(t), y2: y(t), class: 'grid' }), el('text', { x: L - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, `$${t.toFixed(2)}`));
  }
  let lastMonth = '';
  points.forEach((p, i) => { const m = p.date.slice(0, 7); if (m !== lastMonth && i % 2 === 0) { lastMonth = m; if (Number(m.slice(5)) % 2) svg.append(el('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', class: 'tick' }, new Date(`${p.date}T12:00:00`).toLocaleDateString(undefined, { month: 'short' }))); } });
  svg.append(el('polyline', { points: points.map((p, i) => `${x(i)},${y(p.cost)}`).join(' '), class: 'cost-line' }));
  const last = points.at(-1);
  svg.append(el('circle', { cx: x(points.length - 1), cy: y(last.cost), r: 4, class: 'cost-dot' }), el('text', { x: x(points.length - 1) + 8, y: y(last.cost) + 4, class: 'end-label' }, `$${last.cost.toFixed(2)}`));
  // The readout: a line and a dot at the nearest week, with its date and cost.
  const hover = el('g', { class: 'hover', visibility: 'hidden' });
  const vline = el('line', { y1: T, y2: H - B, class: 'hover-line' }), hdot = el('circle', { r: 4, class: 'cost-dot' });
  const box = el('rect', { width: 128, height: 36, rx: 3, class: 'hover-box' }), t1 = el('text', { class: 'hover-date' }), t2 = el('text', { class: 'hover-cost' });
  hover.append(vline, hdot, box, t1, t2);
  svg.append(hover, el('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent', class: 'hit' }));
  const at = (e) => {
    const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((px - L) / (W - L - R)) * (points.length - 1)))), p = points[i];
    hover.setAttribute('visibility', 'visible');
    vline.setAttribute('x1', x(i)); vline.setAttribute('x2', x(i)); hdot.setAttribute('cx', x(i)); hdot.setAttribute('cy', y(p.cost));
    const bx = Math.min(x(i) + 10, W - 132), by = Math.max(T, y(p.cost) - 44);
    box.setAttribute('x', bx); box.setAttribute('y', by);
    t1.setAttribute('x', bx + 10); t1.setAttribute('y', by + 15); t1.textContent = `Week of ${shortDate(p.date)}`;
    t2.setAttribute('x', bx + 10); t2.setAttribute('y', by + 30); t2.textContent = `$${p.cost.toFixed(2)}`;
  };
  svg.addEventListener('pointermove', at); svg.addEventListener('pointerdown', at);
  svg.addEventListener('pointerleave', () => hover.setAttribute('visibility', 'hidden'));
  return h('div', { class: 'chart-wrap' }, svg);
}
/** Cost goals, as a share of sales: the kitchen's food cost under 23%; the bar's pour cost 18–24%. */
const FOOD_COST_GOAL = { high: 0.23 };
const POUR_COST_GOAL = { low: 0.18, high: 0.24 };
const goalText = (goal) => (goal.low ? `${Math.round(goal.low * 100)}–${Math.round(goal.high * 100)}%` : `${Math.round(goal.high * 100)}%`);
/** Where a cost sits against its goal: well under the top is green, near it amber, over it red. */
function foodCostStatus(share, goal = FOOD_COST_GOAL) {
  if (share === null || share === undefined) return { cls: '', label: '' };
  const g = goalText(goal);
  if (share > goal.high) return { cls: 'fc-over', label: `▲ Over the ${g} goal` };
  if (share > goal.high - 0.03) return { cls: 'fc-near', label: goal.low ? `● Near the top of ${g}` : `● Near the ${g} goal` };
  if (goal.low && share < goal.low) return { cls: 'fc-under', label: `✓ Below the ${g} range` };
  return { cls: 'fc-under', label: goal.low ? `✓ In the ${g} range` : `✓ Under the ${g} goal` };
}
/**
 * A category's food cost, under its gross profit at the top of Performance: the period's share,
 * coloured against the goal, and week by week as a line that runs green to red as it climbs,
 * with the goal dashed.
 */
function foodCostPanel(title, share, weeks, values, goal, opts = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const st = goal ? foodCostStatus(share, goal) : { cls: '', label: '' };
  const pts = values.map((v, i) => ({ v, i, week: weeks[i] })).filter((p) => p.v !== null && p.v !== undefined);
  // Small, it opens large above the table, like the pie charts.
  const expand = !opts.large ? h('button', { class: 'link pie-expand', 'aria-label': 'Expand this chart', title: 'Open it large', onclick: (e) => openBig(e.currentTarget, title, foodCostPanel(title, share, weeks, values, goal, { large: true })) }, '⤢ Expand') : null;
  const head = h('div', { class: 'fc-head' }, opts.large ? null : h('span', { class: 'small muted strong', text: title }), opts.large ? null : h('span', { class: 'grow' }),
    h('b', { class: `fc-pct ${st.cls}`, text: pct(share) }), st.label ? h('span', { class: `small strong ${st.cls}`, text: st.label }) : null, expand);
  if (pts.length < 2) return h('div', { class: 'fc-panel' }, head);
  const W = opts.large ? 760 : 320, H = opts.large ? 280 : 150, L = 38, R = 10, T = 10, B = 22;
  const all = [...pts.map((p) => p.v), ...(goal ? [goal.high, goal.low ?? goal.high] : [])];
  const y0 = Math.max(0, Math.floor((Math.min(...all) - 0.02) * 50) / 50), y1 = Math.ceil((Math.max(...all) + 0.02) * 50) / 50;
  const x = (i) => L + (i / Math.max(1, values.length - 1)) * (W - L - R), y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const el = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e; };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', class: 'cost-chart fc-chart', 'aria-label': `${title}: ${pts.map((p) => `week of ${shortDate(p.week)} ${pct(p.v)}`).join(', ')}` });
  // The line's colour follows its height: green under the goal, amber close to it, red over it.
  const gid = `fcg${Math.random().toString(36).slice(2, 8)}`;
  const grad = el('linearGradient', { id: gid, gradientUnits: 'userSpaceOnUse', x1: 0, x2: 0, y1: y(y0), y2: y(y1) });
  const at = (v) => `${Math.max(0, Math.min(100, ((v - y0) / (y1 - y0)) * 100)).toFixed(1)}%`;
  if (goal) for (const [v, c] of [[goal.high - 0.05, 'var(--fc-good)'], [goal.high - 0.02, 'var(--fc-near)'], [goal.high, 'var(--fc-near)'], [goal.high + 0.02, 'var(--fc-bad)']]) grad.append(el('stop', { offset: at(v), 'stop-color': c }));
  else grad.append(el('stop', { offset: '0%', 'stop-color': 'var(--blue)' }));
  svg.append(el('defs', {}));
  svg.firstChild.append(grad);
  const ticks = [];
  const step = y1 - y0 > 0.12 ? 0.05 : 0.02;
  for (let t = Math.ceil(y0 / step - 1e-9) * step; t <= y1 + 1e-9; t += step) ticks.push(t);
  for (const t of ticks) svg.append(el('line', { x1: L, x2: W - R, y1: y(t), y2: y(t), class: 'grid' }), el('text', { x: L - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, `${Math.round(t * 100)}%`));
  // A range is shaded between its ends; a single goal is one dashed line.
  if (goal?.low) svg.append(el('rect', { x: L, width: W - L - R, y: y(goal.high), height: y(goal.low) - y(goal.high), class: 'fc-band' }));
  if (goal) svg.append(el('line', { x1: L, x2: W - R, y1: y(goal.high), y2: y(goal.high), class: 'fc-goal' }), el('text', { x: L + 4, y: goal.low ? y(goal.low) - 5 : y(goal.high) - 5, class: 'fc-goal-label' }, `Goal ${goalText(goal)}`));
  const xTicks = opts.large ? [...new Set([...values.keys()].filter((i) => i % 2 === 0).concat(values.length - 1))] : [0, Math.floor((values.length - 1) / 2), values.length - 1];
  for (const i of xTicks) svg.append(el('text', { x: x(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === values.length - 1 ? 'end' : 'middle', class: 'tick' }, shortDate(weeks[i])));
  // Runs of weeks with sales; a week with none breaks the line.
  let run = [];
  const flush = () => { if (run.length > 1) svg.append(el('polyline', { points: run.join(' '), class: 'fc-line', stroke: `url(#${gid})` })); run = []; };
  values.forEach((v, i) => { if (v === null || v === undefined) flush(); else run.push(`${x(i)},${y(v)}`); });
  flush();
  const dotClass = (v) => (goal ? foodCostStatus(v, goal).cls : '');
  for (const p of pts) svg.append(el('circle', { cx: x(p.i), cy: y(p.v), r: 3, class: `fc-dot ${dotClass(p.v)}` }));
  // The readout: the nearest week, its food cost and where it sits against the goal.
  const hover = el('g', { class: 'hover', visibility: 'hidden' });
  const vline = el('line', { y1: T, y2: H - B, class: 'hover-line' }), hdot = el('circle', { r: 5, class: 'fc-dot' });
  const box = el('rect', { width: 112, height: 36, rx: 3, class: 'hover-box' }), t1 = el('text', { class: 'hover-date' }), t2 = el('text', { class: 'hover-cost' });
  hover.append(vline, hdot, box, t1, t2);
  svg.append(hover, el('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent', class: 'hit' }));
  const show = (e) => {
    const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
    const want = ((px - L) / (W - L - R)) * (values.length - 1);
    const p = pts.reduce((a, b) => (Math.abs(b.i - want) < Math.abs(a.i - want) ? b : a));
    hover.setAttribute('visibility', 'visible');
    vline.setAttribute('x1', x(p.i)); vline.setAttribute('x2', x(p.i));
    hdot.setAttribute('cx', x(p.i)); hdot.setAttribute('cy', y(p.v)); hdot.setAttribute('class', `fc-dot ${dotClass(p.v)}`);
    const bx = x(p.i) + 8 + 112 > W ? x(p.i) - 120 : x(p.i) + 8, by = Math.max(T, Math.min(H - B - 36, y(p.v) - 44));
    box.setAttribute('x', bx); box.setAttribute('y', by);
    t1.setAttribute('x', bx + 8); t1.setAttribute('y', by + 15); t1.textContent = `Week of ${shortDate(p.week)}`;
    t2.setAttribute('x', bx + 8); t2.setAttribute('y', by + 30); t2.textContent = pct(p.v);
  };
  svg.addEventListener('pointermove', show); svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', () => hover.setAttribute('visibility', 'hidden'));
  return h('div', { class: `fc-panel${opts.large ? ' large' : ''}` }, head, h('div', { class: 'chart-wrap' }, svg));
}
/** Where a line's price comes from, with its age as a colour (yellow past 3 months, red past 6). */
function sourceBox(src, kind) {
  if (kind === 'recipe') return h('div', { class: 'src', text: 'its recipe' });
  if (!src) return h('div', { class: 'src age-red' }, h('b', { text: 'No price' }), 'set one');
  if (src.from === 'free') return h('div', { class: 'src', title: src.manual ? 'Marked as costing nothing' : 'Water, ice and soda water cost nothing' }, h('b', { text: 'Free' }), src.manual ? 'set by hand' : 'costs nothing');
  if (src.from === 'marginedge') return h('div', { class: 'src age-red', title: 'Not on an invoice we’ve read: MarginEdge’s last price' }, h('b', { text: 'MarginEdge' }), 'last price');
  const days = src.date ? (Date.now() - Date.parse(`${src.date}T12:00:00`)) / 86_400_000 : 0;
  const age = days > 182 ? ' age-red' : days > 91 ? ' age-yellow' : '';
  if (src.from === 'manual') return h('div', { class: `src${age}` }, h('b', { text: 'Set by hand' }), src.date ? shortDate(src.date) : '');
  const vendor = `${src.garden ? '🌱 ' : ''}${(src.vendor ?? 'Invoice').replace(/,?\s+(inc|llc|co|corp|ltd|company)\.?$/i, '').trim()}`;
  return h('div', { class: `src${age}`, title: `${src.garden ? 'Our garden (free), with what was bought: ' : ''}${src.vendor ?? 'Invoice'}, ${dateWithYear(src.date)}${src.invoices > 1 ? `: the average of ${src.invoices} invoices in the last 60 days` : ''}` },
    h('b', { text: vendor }), `${days > 300 ? dateWithYear(src.date) : shortDate(src.date)}${src.invoices > 1 ? ` · avg of ${src.invoices}` : ''}`);
}
/** Find a recipe or ingredient as you type; picking one opens it in the tree. */
function treeSearch(me, side, open) {
  const input = h('input', { type: 'search', class: 'search-big', placeholder: 'Find a recipe or ingredient', 'aria-label': 'Find a recipe or ingredient' });
  const out = h('div', { class: 'search-pop', hidden: true });
  let timer, asked = '';
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim(); asked = q;
      if (q.length < 2) { out.hidden = true; return; }
      const r = await costGet(`/api/costs/search?q=${encodeURIComponent(q)}`);
      if (asked !== q || !r.ok) return;
      const hits = [...r.data.recipes.map((x) => ({ ...x, kind: 'recipe', label: x.kind === 'prep' ? 'prep' : 'recipe' })), ...r.data.products.map((x) => ({ ...x, kind: 'product', label: perUnitText(x.perUnit, x.unit) }))];
      out.hidden = false;
      fill(out, hits.length ? hits.slice(0, 12).map((x) => h('button', { class: 'linkish lrow', onclick: () => { out.hidden = true; open({ kind: x.kind, id: x.id, name: x.name }); } },
        h('span', { class: 'grow', text: x.name }), h('span', { class: 'small muted', text: x.label }))) : h('div', { class: 'small muted', text: 'Nothing by that name.' }));
    }, 180);
  });
  return h('div', { class: 'search-wrap' }, input, out);
}

/** Recipes: the manager's clean-book home, or the cook's list for today. */
async function recipesScreen(me, state = {}) {
  if (!atLeast(me.roleLevel, 'manager')) return cookRecipes(me);
  loadingScreen(me, 'recipes', 'Recipes');
  const side = sideOf(me);
  const [r, book, sp] = await Promise.all([api('GET', `/api/costs/home?area=${side}`), api('GET', '/api/recipes'), costGet(`/api/costs/sparks?area=${side}`)]);
  if (!r.ok) return show(shell(me, 'recipes', [h('h1', { text: 'Recipes' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const d = r.data, sparks = sp.ok ? sp.data.sparks : {};
  const again = (s = state) => recipesScreen(me, s);
  const here = () => returnTo('Recipes', () => recipesScreen(me, state));
  const open = (node) => recipeTree(me, [node]);
  const filter = state.filter;
  const c = d.counts;
  // Tiles: only what's there; the marker ones filter the list below, the others open their page.
  const tile = (key, cls, title, n, sub, go) => (n ? h('button', { class: `attn-tile ${cls}${filter === key ? ' on' : ''}`, 'aria-pressed': filter === key ? 'true' : 'false', onclick: go ?? (() => again({ ...state, filter: filter === key ? undefined : key })) },
    h('span', { class: 't', text: title }), h('b', { text: String(n) }), h('span', { class: 's', text: sub })) : null);
  const tiles = [
    tile('checks', 'red', 'Recipe checks', c.checks, 'ingredients not bought, bought but in no recipe, vendors gone quiet', () => recipeChecksScreen(me, { from: here() })),
    tile('noCost', 'red', 'Can’t be fully costed', c.noCost, 'a line with no price, or a unit that won’t convert'),
    tile('red', 'red', 'Old prices', c.red, 'a price over 6 months old, or MarginEdge’s last'),
    tile('notBought', 'red', 'Ingredient not bought', c.notBought, 'the recipe may name something you stopped buying'),
    tile('yellow', 'amber', 'Prices getting old', c.yellow, 'a price over 3 months old'),
    tile('rough', 'amber', 'Rough recipes', c.rough, 'not marked ready: cooks don’t see them'),
    tile('noRecipe', 'blue', 'Selling without a recipe', c.noRecipe, `${dollars(c.noRecipeSales)} in 90 days, not in food cost`, () => coverageScreen(me)),
  ].filter(Boolean);
  const shown = (m) => (!filter ? hasMarks(m) : Boolean(m[filter]?.length));
  const dishes = d.dishes.filter((x) => shown(x.markers)), others = d.others.filter((x) => shown(x.markers));
  const dishRow = (x) => h('button', { class: 'rt-row', onclick: () => open({ kind: 'recipe', id: x.id, name: x.name, cost: x.plateCost }) },
    h('div', { class: 'nm' }, h('b', { text: x.name }), markerChips(x.markers)),
    h('div', {}, costSpark(sparks[x.id])), h('div', { class: 'num' }, sparkChange(sparks[x.id])),
    h('div', { class: 'num', text: dollars(x.plateCost, { cents: true }) }), h('div', { class: 'num', text: dollars(x.price, { cents: true }) }),
    h('div', { class: 'num strong', text: x.share !== undefined ? `${Math.round(x.share * 100)}%` : '–' }), h('div', { class: 'chev', 'aria-hidden': 'true', text: '›' }));
  const otherRow = (x) => h('button', { class: 'rt-row', onclick: () => open({ kind: 'recipe', id: x.id, name: x.name }) },
    h('div', { class: 'nm' }, h('b', { text: x.name }), markerChips(x.markers)), h('div', { class: 'small muted', text: KIND_NAMES[x.kind] ?? x.kind }),
    h('div'), h('div'), h('div'), h('div'), h('div', { class: 'chev', 'aria-hidden': 'true', text: '›' }));
  const clean = !d.dishes.length && !d.others.length;
  const list = clean
    ? h('section', { class: 'card all-clear' }, h('div', { class: 'big good-text', text: '✓' }), h('h2', { text: 'Nothing needs a look' }),
      h('div', { class: 'small muted', text: `All ${d.allDishes} ${side === 'bar' ? 'drinks' : 'dishes'} are costed from recent prices, and every recipe is ready.` }))
    : h('section', { class: 'card' },
      h('div', { class: 'row wrap' }, h('h2', { class: 'grow', text: filter ? `${MARKERS.find(([k]) => k === filter)?.[3] ?? 'Needs a look'}` : 'Needs a look' }),
        filter ? h('button', { class: 'link', text: 'Show everything that needs a look', onclick: () => again({ ...state, filter: undefined }) }) : h('span', { class: 'small muted', text: `${d.dishes.length} of ${d.allDishes} ${side === 'bar' ? 'drinks' : 'dishes'}` })),
      dishes.length ? h('div', { class: 'ttable' },
        h('div', { class: 'rt-row head' }, ['Dish', 'Cost, 12 months', '90 days', 'Plate cost', 'Price', 'Food cost', ''].map((t, i) => h('div', { class: i > 1 && i < 6 ? 'num' : '', text: t }))),
        dishes.map(dishRow)) : null,
      others.length ? [h('h3', { class: 'sub-h', text: 'Recipes no selling dish uses' }), h('div', { class: 'ttable' }, others.map(otherRow))] : null,
      !dishes.length && !others.length ? h('div', { class: 'small muted', text: 'Nothing with that marker.' }) : null,
      h('div', { class: 'small muted', text: 'A marker on a dish is somewhere under it: tap down to find it. Fix it, and the dish leaves this list.' }));
  const newRecipe = h('button', { class: 'btn dark', text: 'New recipe', onclick: async () => { const cd = (await api('GET', `/api/cards?area=${side}`)).data; cardEditor(me, cd, null, { kind: side === 'bar' ? 'drink' : 'dish', back: { label: 'Recipes', go: (saved) => (saved ? recipePage(me, saved) : recipesScreen(me)), rail: 'recipes' } }); } });
  const coverage = book.ok && book.data.coverage?.[side] ? coverageCard(me, book.data.coverage[side], side) : null;
  const recent = d.recent.length ? sideBox('Recently changed', h('div', { class: 'list compact' }, d.recent.map((x) => h('button', { class: 'linkish lrow', onclick: () => open({ kind: 'recipe', id: x.id, name: x.name }) },
    h('span', { class: 'grow', text: x.name }), h('span', { class: 'small muted', text: `${x.by ?? ''} · ${when(x.at)}` }))))) : null;
  const browse = sideBox('Browse the whole book', sideActions(
    h('button', { class: 'btn small-btn', text: `Every ${side === 'bar' ? 'drink' : 'dish'} (${d.allDishes})`, onclick: () => recipeTree(me, [{ kind: 'menu', name: side === 'bar' ? 'Every drink' : 'Every dish' }]) }),
    h('button', { class: 'btn small-btn', text: 'All recipes A–Z', onclick: () => recipesAZ(me, here()) }),
    h('button', { class: 'btn small-btn', text: 'Modifiers', onclick: () => modifiersScreen(me, here()) }),
    h('button', { class: 'btn small-btn', text: 'Recipe costs', onclick: () => cardsScreen(me) })));
  show(shell(me, 'recipes', [
    h('header', { class: 'row wrap' },
      h('div', { class: 'grow' }, h('div', { class: 'kicker', text: AREA_NAMES[side] }), h('h1', { text: 'Recipes' })),
      h('div', { class: 'row wrap' }, treeSearch(me, side, open), sideSwitch(me, () => recipesScreen(me)), newRecipe)),
    page([tiles.length ? h('div', {}, h('div', { class: 'small muted strong attn-h', text: 'Needs attention' }), h('div', { class: 'attn' }, tiles)) : null, list], [coverage, recent, browse]),
  ]));
}

/** The tree: Recipes › a dish › a prep › an ingredient. Each step shows its cost over time and its lines. */
async function recipeTree(me, trail) {
  const node = trail.at(-1);
  const side = sideOf(me);
  const go = (next) => recipeTree(me, next);
  const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Where you are' },
    h('button', { class: 'crumb', onclick: () => recipesScreen(me) }, h('span', { text: 'Recipes' })),
    trail.map((n, i) => [h('span', { class: 'crumb-sep', 'aria-hidden': 'true', text: '›' }),
      h('button', { class: `crumb${i === trail.length - 1 ? ' on' : ''}`, 'aria-current': i === trail.length - 1 ? 'page' : undefined, onclick: () => go(trail.slice(0, i + 1)) },
        h('span', { text: n.name }), n.cost !== undefined ? h('b', { text: dollars(n.cost, { cents: true }) }) : null)]));
  const down = (x) => go([...trail, x]);
  loadingScreen(me, 'recipes', node.name);
  let main, sideBoxes;
  if (node.kind === 'menu') [main, sideBoxes] = await treeMenu(me, side, down);
  else if (node.kind === 'product') [main, sideBoxes] = await treeProduct(me, node, trail, down, () => recipeTree(me, trail));
  else [main, sideBoxes] = await treeRecipe(me, node, trail, down, () => recipeTree(me, trail));
  show(shell(me, 'recipes', [crumbs, page(main, sideBoxes)]));
}

async function treeMenu(me, side, down) {
  const [r, sp] = await Promise.all([costGet(`/api/costs/menu?area=${side}`), costGet(`/api/costs/sparks?area=${side}`)]);
  if (!r.ok) return [[h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })], []];
  const sparks = sp.ok ? sp.data.sparks : {};
  const cats = new Map();
  for (const x of r.data.dishes) cats.set(x.category ?? 'Other', [...(cats.get(x.category ?? 'Other') ?? []), x]);
  return [[...cats].map(([cat, xs]) => h('section', { class: 'card' }, h('div', { class: 'row' }, h('h2', { class: 'grow', text: cat }), h('span', { class: 'small muted', text: `${xs.length}` })),
    h('div', { class: 'ttable' }, h('div', { class: 'rt-row head' }, ['Dish', 'Cost, 12 months', '90 days', 'Plate cost', 'Price', 'Food cost', ''].map((t, i) => h('div', { class: i > 1 && i < 6 ? 'num' : '', text: t }))),
      xs.sort((a, b) => (b.share ?? 0) - (a.share ?? 0)).map((x) => h('button', { class: 'rt-row', onclick: () => down({ kind: 'recipe', id: x.id, name: x.name, cost: x.plateCost }) },
        h('div', { class: 'nm' }, h('b', { text: x.name }), markerChips(x.markers, 2)), h('div', {}, costSpark(sparks[x.id])), h('div', { class: 'num' }, sparkChange(sparks[x.id])),
        h('div', { class: 'num', text: dollars(x.plateCost, { cents: true }) }), h('div', { class: 'num', text: dollars(x.price, { cents: true }) }),
        h('div', { class: 'num strong', text: x.share !== undefined ? `${Math.round(x.share * 100)}%` : '–' }), h('div', { class: 'chev', 'aria-hidden': 'true', text: '›' })))))),
  [sideBox('The markers', markerKey())]];
}
function markerKey() {
  return h('div', { class: 'alertlist' }, MARKERS.map(([k, icon, label, text]) => h('div', { class: 'a' }, h('span', { class: `mk mk-${k}`, text: icon || label }), h('span', { text: icon ? text : text.replace(/^[^:]+: /, '') }))),
    h('div', { class: 'small muted', text: 'A marker on a dish is somewhere under it: tap down to find it.' }));
}
/** "Needs a look" for a recipe or ingredient: each marker with what it's on, and the swap when there is one. */
function needsALook(me, markers, stale, reload) {
  if (!hasMarks(markers)) return sideBox('Needs a look', h('div', { class: 'small good-text', text: '✓ Nothing under this one.' }));
  const staleBox = (x) => h('div', { class: 'rstale' },
    h('div', { class: 'small' }, h('b', { text: x.name }), ` hasn’t been on an invoice ${x.last ? `since ${shortDate(x.last.date)}` : 'we have'}, though the menu uses about ${x.perWeek >= 10 ? Math.round(x.perWeek) : Math.round(x.perWeek * 10) / 10} ${UNIT_LABEL(x.unit)} a week.`,
      x.likely ? [' You’ve been buying ', h('b', { text: x.likely.name }), `${x.likely.vendor ? ` (${x.likely.vendor})` : ''}${x.likely.inNoRecipe ? ', and no recipe uses it' : ''}.`] : null),
    h('div', { class: 'row tight wrap' },
      x.likely ? h('button', { class: 'btn small-btn dark', text: 'Swap it in', title: `Swap in ${x.likely.name}`, onclick: (e) => pageAction(async () => { busy(e.currentTarget, true); const res = await api('POST', '/api/cards/swap', { from: x.productId, to: x.likely.productId, recipes: x.recipes }); if (res.ok) reload(); else busy(e.currentTarget, false); }) }) : null,
      h('button', { class: 'btn small-btn', text: 'It’s right as is', onclick: (e) => pageAction(async () => { busy(e.currentTarget, true); await api('POST', '/api/answers', { type: 'dismiss', dedupeKey: `ingredient:notBought:${x.productId}`, note: `${x.name}: right as is, though not bought lately` }); reload(); }) }),
      h('button', { class: 'link', text: 'More', onclick: () => recipeChecksScreen(me, { from: returnTo('Back', reload) }) })));
  return sideBox('Needs a look',
    h('div', { class: 'alertlist' }, MARKERS.filter(([k]) => markers[k]?.length && k !== 'notBought').map(([k, icon, label]) => h('div', { class: 'a' }, h('span', { class: `mk mk-${k}`, text: icon }), h('span', {}, h('b', { text: label }), `: ${markers[k].join(', ')}`)))),
    (stale ?? []).map(staleBox));
}
async function treeRecipe(me, node, trail, down, reload) {
  const q = node.amount ? `?amount=${node.amount}&unit=${encodeURIComponent(node.unit)}` : '';
  const [r, hist] = await Promise.all([costGet(`/api/costs/recipe/${encodeURIComponent(node.id)}${q}`, true), costGet(`/api/costs/history/${encodeURIComponent(node.id)}`, true)]);
  if (!r.ok) return [[h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })], []];
  const d = r.data, hs = hist.ok ? hist.data : null;
  const dish = d.price !== undefined;
  const parent = trail.at(-2);
  const head = h('section', { class: 'card' },
    h('div', { class: 'row wrap' },
      h('div', { class: 'grow' }, h('div', { class: 'row tight wrap' }, h('h2', { text: d.name }), d.rough ? h('span', { class: 'tag rough', text: 'Rough' }) : null),
        h('div', { class: 'small muted', text: dish ? 'Plate cost as the recipe is written, priced at each week’s invoices' : `Prep · one batch is ${unitAmount(d.yield.amount, d.yield.unit)}${node.amount && parent ? ` · ${parent.name} uses ${unitAmount(node.amount, node.unit)}` : ''}` })),
      h('div', { class: 'right-col' }, h('div', { class: 'big', text: dollars(dish ? d.total : d.perBatch, { cents: true }) }),
        h('div', { class: 'small muted', text: dish ? `${d.total && d.price ? Math.round((d.total / d.price) * 100) : '–'}% of the ${dollars(d.price, { cents: true })} it sells for` : 'a batch' }))),
    hs && hs.points.length > 1 ? [costChart(hs.points, `${d.name} cost over 12 months`),
      h('div', { class: 'small muted', text: `A year ago ${dollars(hs.points[0].cost, { cents: true })} · 90 days ago ${dollars(hs.points.at(-14)?.cost ?? hs.points[0].cost, { cents: true })} · now ${dollars(hs.points.at(-1).cost, { cents: true })}` })] : null);
  const lines = h('section', { class: 'card' }, h('h2', { text: 'What goes in' }),
    h('div', { class: 'ttable' }, h('div', { class: 'lrow2 head' }, ['Goes in', 'Amount', 'Price from', 'Cost', 'Share', ''].map((t, i) => h('div', { class: i === 1 || i === 3 || i === 4 ? 'num' : '', text: t }))),
      d.lines.map((l) => {
        const can = l.kind === 'recipe' || l.kind === 'product';
        return h(can ? 'button' : 'div', { class: `lrow2${can ? ' clickable' : ''}`, onclick: can ? () => down({ kind: l.kind, id: l.id, name: l.name, amount: l.amount, unit: l.unit, cost: l.cost }) : undefined },
          h('div', { class: 'nm' }, h('span', {}, h('b', { text: l.name }), l.kind === 'recipe' ? h('span', { class: 'small muted', text: ' · recipe' }) : null), markerChips(l.markers, 2)),
          h('div', { class: 'num small', text: unitAmount(l.amount, UNIT_LABEL(l.unit)) }),
          h('div', {}, sourceBox(l.source, l.kind)),
          h('div', { class: 'num' }, l.complete ? dollars(l.cost, { cents: true }) : h('span', { class: 'warn-text small', text: 'no cost' })),
          h('div', { class: 'num small', text: `${Math.round(l.share * 100)}%` }),
          h('div', { class: 'chev', 'aria-hidden': 'true', text: can ? '›' : '' }));
      })));
  const moved = hs?.drivers?.length ? sideBox('What moved it in 90 days', h('div', { class: 'moved' }, hs.drivers.slice(0, 5).map((x) => h('div', { class: 'row' }, h('span', { class: 'grow', text: x.name }), h('span', { class: x.change > 0 ? 'up-bad' : 'down-good', text: `${x.change > 0 ? '+' : '−'}${dollars(Math.abs(x.change), { cents: true })}` }))))) : null;
  const recipeName = d.name;
  const actions = sideBox(dish ? `Sells as ${recipeName}` : 'Used in',
    !dish && d.usedIn.length ? h('div', { class: 'small' }, d.usedIn.map((u, k) => [k ? ', ' : '', h('button', { class: 'linkish card-link', text: u.name, onclick: () => recipeTree(me, [{ kind: 'recipe', id: u.id, name: u.name }]) })])) : null,
    dish ? h('div', { class: 'small muted', text: `${(d.sold ?? 0).toLocaleString()} sold in 90 days` }) : null,
    sideActions(h('button', { class: 'btn small-btn', text: 'Open the recipe', onclick: () => recipePage(me, recipeName, { from: returnTo(recipeName, reload) }) }),
      h('button', { class: 'btn small-btn', text: 'Edit recipe', onclick: async () => { const cd = (await api('GET', '/api/cards')).data; const c = cd.cards.find((x) => x.name === recipeName); if (c) cardEditor(me, cd, c, { back: { label: recipeName, go: () => { costCache.clear(); reload(); }, rail: 'recipes' } }); } })));
  // A dish: its variations and modifiers, loaded after the page shows (one click away from the menu).
  const extras = dish ? itemExtras(me, node.id, d.name, d.lines.filter((l) => l.kind === 'product' || l.kind === 'recipe'), null) : null;
  const history = recipeHistoryBox({ id: node.id, name: d.name }, () => { costCache.clear(); reload(); });
  // Allergens, worked out through every prep in it (loaded after the page shows).
  const allergens = h('div');
  api('GET', `/api/recipes/${encodeURIComponent(d.name)}`).then((x) => { if (x.ok && x.data.allergens) fill(allergens, allergenSide(x.data.allergens)); });
  return [[head, lines, extras], [needsALook(me, d.markers, d.stale, () => { costCache.clear(); reload(); }), allergens, moved, actions, history]];
}
async function treeProduct(me, node, trail, down, reload) {
  const q = node.amount ? `?amount=${node.amount}&unit=${encodeURIComponent(node.unit)}` : '';
  const r = await costGet(`/api/costs/product/${encodeURIComponent(node.id)}${q}`, true);
  if (!r.ok) return [[h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })], []];
  const d = r.data;
  const [main, boxes] = productNode(d, node, (next) => { const n = next.at(-1); recipeTree(me, n.kind === 'recipe' ? [...trail, n] : next); });
  // Where its price comes from, and a price set by hand when there's none (or it's wrong).
  const priceIn = h('input', { inputmode: 'decimal', class: 'short', placeholder: '0.00', 'aria-label': `Price of ${d.name}` });
  const msg = h('span', { class: 'small error' });
  const setForm = h('div', { class: 'row tight wrap', hidden: true }, h('span', { text: '$' }), priceIn, h('span', { class: 'small', text: `a ${UNIT_LABEL(d.unit)}` }),
    h('button', { class: 'btn small-btn dark', text: 'Set', onclick: () => pageAction(async () => {
      const v = parseAmount(priceIn.value.replace('$', ''));
      if (!(v > 0)) return (msg.textContent = 'A price like 4.25');
      const res = await api('POST', '/api/answers', { type: 'price', productId: d.id, price: v, amount: 1, unit: d.unit });
      if (!res.ok) return (msg.textContent = res.data.error ?? 'Not saved.');
      costCache.clear(); reload();
    }) }), msg);
  const src = d.source;
  const source = sideBox('Where the price comes from',
    h('div', {}, sourceBox(src, 'product')),
    h('div', { class: 'small muted', text: !src ? 'No invoice we’ve read has it, and MarginEdge has no last price.' : src.from === 'free' ? (src.manual ? 'Marked as costing nothing. Set a price to change that.' : 'Water, ice and soda water count as free unless an invoice prices them.') : src.from === 'marginedge' ? 'Not on an invoice we’ve read: this is MarginEdge’s last price, which may be old.' : src.from === 'manual' ? 'Set by hand. A newer invoice takes over when one comes in.' : src.invoices > 1 ? `The average of ${src.invoices} invoices in the last 60 days, latest shown.` : 'The latest invoice.' }),
    h('div', { class: 'row tight wrap' },
      h('button', { class: 'link', text: src ? 'Set a price by hand' : 'Set a price', onclick: () => { setForm.hidden = false; priceIn.focus(); } }),
      src?.from === 'free' ? null : h('button', { class: 'link', text: 'It costs nothing', title: 'Soda from the gun, herbs from the garden: counted at $0', onclick: () => pageAction(async () => { const res = await api('POST', '/api/answers', { type: 'price', productId: d.id, price: 0, amount: 1, unit: d.unit }); if (res.ok) { costCache.clear(); reload(); } }) })),
    setForm);
  return [main, [needsALook(me, d.markers, d.stale, () => { costCache.clear(); reload(); }), ingredientAllergens(node.id), source, ...boxes]];
}

/** Every recipe on a side, A to Z, for when you know it's there. */
async function recipesAZ(me, from) {
  loadingScreen(me, 'recipes', 'All recipes');
  const side = sideOf(me);
  const r = await api('GET', '/api/recipes');
  const all = (r.ok ? r.data[side] : []).flatMap((s) => s.cards).sort((a, b) => a.name.localeCompare(b.name));
  const search = h('input', { type: 'search', class: 'search-big', placeholder: 'Find a recipe', 'aria-label': 'Find a recipe' });
  const list = h('div', { class: 'az' });
  const draw = () => { const q = search.value.trim().toLowerCase(); fill(list, all.filter((c) => !q || c.name.toLowerCase().includes(q)).map((c) => h('button', { class: 'az-row', onclick: () => recipeTree(me, [{ kind: 'recipe', id: c.id, name: c.name }]) }, h('span', { class: 'grow', text: c.name }), c.rough ? h('span', { class: 'tag rough', text: 'rough' }) : null, h('span', { class: 'chev', text: '›' })))); };
  search.addEventListener('input', draw); draw();
  show(shell(me, 'recipes', [h('header', { class: 'row wrap' }, h('div', { class: 'grow' }, h('div', { class: 'kicker', text: AREA_NAMES[side] }), h('h1', { text: 'All recipes' })),
    h('div', { class: 'row wrap' }, search, sideSwitch(me, () => recipesAZ(me, from)), from ? h('button', { class: 'btn', text: `← ${from.label}`, onclick: () => from.go() }) : null)),
  page(h('section', { class: 'card' }, list), [])]));
}

/** For cooks: what's on their station's list today (each opens its recipe, scaled), then a search for the rest. */
async function cookRecipes(me) {
  loadingScreen(me, 'recipes', 'Recipes');
  const [book, prep] = await Promise.all([api('GET', '/api/recipes'), api('GET', '/api/prep')]);
  const all = book.ok ? [...book.data.kitchen, ...book.data.bar].flatMap((s) => s.cards) : [];
  const p = prep.ok ? prep.data : null;
  const stationId = me.device?.stationId ?? recall('station');
  const stations = p ? (stationId && p.stations.some((s) => s.id === stationId) ? p.stations.filter((s) => s.id === stationId) : p.stations) : [];
  const lists = await Promise.all(stations.map(async (s) => ({ s, v: (await api('GET', `/api/prep/${s.id}/${p.today}`)).data })));
  const today = lists.map(({ s, v }) => ({ s, lines: (v?.lines ?? []).filter((l) => l.recipeName && (l.kind === 'task' || (l.toMake ?? 0) > 0)) })).filter((x) => x.lines.length);
  const results = h('div', { class: 'cook-list' });
  const search = h('input', { type: 'search', class: 'search-big', placeholder: 'Find a recipe', 'aria-label': 'Find a recipe' });
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    fill(results, q.length < 2 ? null : all.filter((c) => c.name.toLowerCase().includes(q) || (c.sellsAs ?? '').toLowerCase().includes(q)).slice(0, 20)
      .map((c) => h('button', { onclick: () => recipePage(me, c.name, { from: returnTo('Recipes', () => cookRecipes(me)) }) }, h('span', { text: c.name }), h('span', { class: 'chev', text: '›' }))));
  });
  show(shell(me, 'recipes', [
    h('header', { class: 'row wrap' }, h('div', { class: 'grow' }, h('h1', { text: 'Recipes' }))),
    page([
      today.length ? today.map(({ s, lines }) => h('section', { class: 'card' }, h('div', { class: 'row' }, h('h2', { class: 'grow', text: `On the ${s.name} list today` }), h('span', { class: 'small muted', text: 'opens scaled to what the list says' })),
        h('div', { class: 'cook-list' }, lines.map((l) => h('button', { onclick: () => recipeSheet(me, l.recipeName, { amount: l.toMake, unit: l.unit }) },
          h('span', { text: l.recipeName }), h('span', { class: 'small muted', text: l.toMake ? `make ${amountWithWeight(l.toMake, l.unit, l)} ›` : '›' })))))) : h('section', { class: 'card small muted', text: 'Nothing with a recipe on today’s list yet.' }),
      h('section', { class: 'card' }, h('h2', { text: 'Any other recipe' }), search, results),
    ], []),
  ]));
  search.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- Variations and modifiers
//
// On an item's page, under its recipe: its variations side by side, and each modifier sold with it,
// what one use adds or takes off, and what that costs. A modifier is set once: Square shares modifier
// lists across items, so the page says where else it's used before you change it.

const MOD_STATUS = {
  notSet: ['mk mk-noCost', 'not set'], assumed: ['mk mk-yellow', 'guessed'], set: [null, ''], nothing: ['tag', 'no food change'], none: ['tag', 'service only'],
};
const MOD_UNITS = ['oz', 'floz', 'g', 'lb', 'each', 'slice', 'portion', 'tsp', 'tbsp', 'cup', 'ml', 'pump'];
let modItems = null; // products and preps to pick from, loaded once
async function modPickList() {
  if (modItems) return modItems;
  const r = await costGet('/api/cards');
  modItems = r.ok ? [...r.data.products.map((p) => ({ kind: 'product', id: p.id, name: p.name })), ...r.data.allCards.filter((c) => c.kind === 'prep' || c.kind === 'barPrep').map((c) => ({ kind: 'recipe', id: c.id, name: c.name }))] : [];
  return modItems;
}
const modText = (m) => {
  const part = (x) => `${qty(x.amount)} ${UNIT_LABEL(x.unit)} ${x.name}`;
  if (m.status === 'none') return 'No change to the food';
  if (m.status === 'nothing') return 'Changes nothing';
  if (m.status === 'notSet') return m.action === 'remove' ? 'Takes off: not set' : 'Adds: not set';
  return [m.adds.length ? `Adds ${m.adds.map(part).join(' + ')}` : '', m.removes.length ? `takes off ${m.removes.map(part).join(' + ')}` : ''].filter(Boolean).join(', ') || 'Changes nothing';
};

/** The section on an item's page (recipeId) or the whole Modifiers page (no recipeId). */
function modifierSection(me, ctx, d, reload) {
  const shared = (list) => list.on.filter((n) => !ctx.dishName || n.toLowerCase() !== ctx.dishName.toLowerCase());
  const save = async (answers, btn, msg) => pageAction(async () => {
    busy(btn, true);
    const res = await api('POST', '/api/modifiers/answer', { answers });
    if (!res.ok) { busy(btn, false); msg.textContent = res.data.error ?? 'Not saved.'; return; }
    costCache.clear();
    reload();
  });
  const editor = (m, slot) => {
    const msg = h('span', { class: 'small error' });
    const lines = (m.adds.length ? m.adds : m.suggest ? [{ ...m.suggest, amount: m.suggest.amount ?? '', unit: m.suggest.unit ?? '' }] : [{ amount: '', unit: '', name: '' }]).map((x) => ({ ...x }));
    const box = h('div', { class: 'mod-edit' });
    const draw = async () => {
      const items = await modPickList();
      const listId = 'mod-items';
      fill(box,
        document.getElementById(listId) ? null : h('datalist', { id: listId }, items.map((i) => h('option', { value: i.name }))),
        document.getElementById('mod-units') ? null : h('datalist', { id: 'mod-units' }, MOD_UNITS.map((u) => h('option', { value: UNIT_LABEL(u) }))),
        m.action !== 'remove' ? [h('div', { class: 'small strong', text: 'One use adds' }),
          lines.map((x, n) => {
            const amt = h('input', { inputmode: 'decimal', class: 'short', value: x.amount === '' ? '' : String(x.amount), placeholder: '1.5', 'aria-label': 'Amount' });
            const unit = h('input', { type: 'text', class: 'short', list: 'mod-units', value: x.unit ? UNIT_LABEL(x.unit) : '', placeholder: 'oz', 'aria-label': 'Unit' });
            const name = h('input', { type: 'text', list: listId, class: 'grow-in', value: x.name ?? '', placeholder: 'Raspberry syrup, mozzarella…', 'aria-label': 'Ingredient' });
            amt.addEventListener('change', () => { x.amount = parseAmount(amt.value); });
            unit.addEventListener('change', () => { x.unit = unit.value.trim() === 'fl oz' ? 'floz' : unit.value.trim(); });
            name.addEventListener('change', () => { const it = items.find((i) => i.name.toLowerCase() === name.value.trim().toLowerCase()); x.name = name.value.trim(); x.kind = it?.kind; x.id = it?.id; });
            return h('div', { class: 'row tight wrap' }, amt, unit, name, lines.length > 1 ? h('button', { class: 'btn small-btn', text: '×', 'aria-label': 'Remove line', onclick: () => { lines.splice(n, 1); draw(); } }) : null);
          }),
          h('button', { class: 'link', text: '+ Another ingredient', onclick: () => { lines.push({ amount: '', unit: '', name: '' }); draw(); } })] : null,
        (m.action === 'remove' || m.action === 'swap') && ctx.dishLines ? [h('div', { class: 'small strong', text: 'Takes off' }),
          (() => { const sel = h('select', { 'aria-label': 'Takes off' }, h('option', { value: '', text: 'Nothing' }), ctx.dishLines.map((l) => h('option', { value: `${l.kind}|${l.id}`, text: l.name, selected: m.removes[0]?.id === l.id ? true : undefined }))); box.takeOff = sel; return sel; })(),
          h('label', { class: 'row tight small' }, (() => { const c = h('input', { type: 'checkbox', checked: true }); box.everyDish = c; return c; })(), 'On every item it’s sold with')] : null,
        h('div', { class: 'row tight wrap' },
          h('button', { class: 'btn small-btn dark', text: 'Save', onclick: (e) => {
            const adds = m.action === 'remove' ? undefined : lines.filter((x) => x.name);
            if (adds && adds.some((x) => !x.id || !(x.amount > 0) || !x.unit)) return (msg.textContent = 'Each line: an amount, a unit, and an ingredient picked from the list.');
            const answer = { key: m.key, ...(adds ? { adds: adds.map((x) => ({ kind: x.kind, id: x.id, amount: x.amount, unit: x.unit })) } : {}) };
            if (box.takeOff) { const [kind, ...id] = box.takeOff.value.split('|'); answer.removes = { dish: box.everyDish?.checked ? '*' : ctx.recipeId, item: box.takeOff.value ? { kind, id: id.join('|') } : null }; }
            save([answer], e.currentTarget, msg);
          } }),
          m.action === 'remove' ? null : h('button', { class: 'btn small-btn', text: 'Changes nothing', onclick: (e) => save([{ key: m.key, nothing: true }], e.currentTarget, msg) }),
          h('button', { class: 'link', text: 'Cancel', onclick: () => fill(slot) }), msg));
    };
    draw();
    fill(slot, box);
  };
  const row = (m) => {
    const slot = h('div');
    const [cls, label] = MOD_STATUS[m.status] ?? [null, ''];
    return h('div', { class: 'mod-row' },
      h('button', { class: 'mod-line', disabled: m.status === 'none' ? true : undefined, onclick: () => (slot.firstChild ? fill(slot) : editor(m, slot)) },
        h('div', { class: 'nm' }, h('span', {}, h('b', { text: m.name.replace(/^[\s+*\-–]+/, '') }), cls ? h('span', { class: cls, text: label }) : null),
          h('span', { class: 'small muted', text: modText(m) })),
        h('div', { class: 'num small muted', text: m.share !== undefined ? `${Math.round(m.share * 100)}% of plates` : `${m.uses.toLocaleString()} uses` }),
        h('div', { class: 'num', text: m.status === 'none' ? '' : m.status === 'notSet' ? '–' : `${m.costPerUse < 0 ? '−' : '+'}${dollars(Math.abs(m.costPerUse), { cents: true })}` }),
        h('div', { class: 'chev', 'aria-hidden': 'true', text: m.status === 'none' ? '' : '›' })),
      slot);
  };
  // A choice list ("Syrup": Raspberry, Vanilla…): one amount for every choice, each its matching ingredient.
  const sameForAll = (list) => {
    const open = list.modifiers.filter((m) => m.status === 'notSet' && m.action === 'ask');
    if (open.length < 2) return null;
    const slot = h('div');
    const go = () => {
      const amt = h('input', { inputmode: 'decimal', class: 'short', placeholder: '1.5', 'aria-label': 'Amount' });
      const unit = h('input', { type: 'text', class: 'short', list: 'mod-units', placeholder: 'oz', 'aria-label': 'Unit' });
      const msg = h('span', { class: 'small error' });
      fill(slot, h('div', { class: 'mod-edit' },
        h('div', { class: 'small strong', text: `Every choice adds the same amount of its own ingredient` }),
        h('div', { class: 'row tight wrap' }, amt, unit, h('span', { class: 'small', text: 'of the matching ingredient' })),
        h('div', { class: 'small' }, open.map((m) => h('div', {}, h('span', { text: `${m.name} → ` }), m.suggest ? h('b', { text: m.suggest.name }) : h('span', { class: 'warn-text', text: 'no match: set it on its own' })))),
        h('div', { class: 'row tight wrap' }, h('button', { class: 'btn small-btn dark', text: 'Save for all', onclick: (e) => {
          const a = parseAmount(amt.value), u = unit.value.trim() === 'fl oz' ? 'floz' : unit.value.trim();
          if (!(a > 0) || !u) return (msg.textContent = 'An amount and a unit, like 1.5 oz.');
          save(open.filter((m) => m.suggest).map((m) => ({ key: m.key, adds: [{ kind: m.suggest.kind, id: m.suggest.id, amount: a, unit: u }] })), e.currentTarget, msg);
        } }), h('button', { class: 'link', text: 'Cancel', onclick: () => fill(slot) }), msg)));
    };
    return [h('button', { class: 'link', text: `Same for every choice (${open.length} not set)`, onclick: go }), slot];
  };
  return (d.lists ?? []).map((list) => {
    const others = shared(list);
    return h('section', { class: 'card' },
      h('div', { class: 'row wrap' }, h('h2', { class: 'grow', text: list.listName }),
        ctx.recipeId ? null : h('span', { class: 'small muted', text: `${list.uses.toLocaleString()} uses` })),
      !ctx.recipeId && list.on.length === 1 ? h('div', { class: 'small muted', text: `On ${list.on[0]}` }) : null,
      others.length && (ctx.recipeId || list.on.length > 1) ? h('div', { class: 'note small' }, h('b', { text: ctx.recipeId ? 'Shared. ' : 'On: ' }),
        `${ctx.recipeId ? 'Also on ' : ''}${others.slice(0, 5).join(', ')}${others.length > 5 ? ` and ${others.length - 5} more` : ''}.${ctx.recipeId ? ' Changing a modifier here changes it there too.' : ''}`) : null,
      h('div', { class: 'mod-list' }, list.modifiers.map(row)),
      sameForAll(list));
  });
}

/** On a dish's page: its variations and modifiers, loaded after the page shows. */
function itemExtras(me, recipeId, dishName, dishLines, reloadPage) {
  const box = h('div', { class: 'item-extras' }, h('section', { class: 'card small muted', text: 'Loading variations and modifiers…' }));
  const load = async () => {
    const r = await costGet(`/api/modifiers?recipe=${encodeURIComponent(recipeId)}`, true);
    if (!r.ok) return fill(box, h('section', { class: 'card small error', text: r.data.error ?? 'Couldn’t load modifiers.' }));
    const d = r.data;
    const variations = d.variations.length > 1 ? h('section', { class: 'card' }, h('h2', { text: 'Variations' }),
      h('div', { class: 'ttable' }, h('div', { class: 'rt-row head vars' }, ['Sold as', 'Sold', 'Price', 'Recipe cost', 'With modifiers'].map((t, i) => h('div', { class: i ? 'num' : '', text: t }))),
        d.variations.map((v) => h('div', { class: 'rt-row vars' }, h('div', { class: 'strong', text: v.name }), h('div', { class: 'num', text: v.sold.toLocaleString() }), h('div', { class: 'num', text: dollars(v.price, { cents: true }) }), h('div', { class: 'num', text: dollars(v.cost, { cents: true }) }), h('div', { class: 'num', text: dollars(v.plateCost, { cents: true }) }))))) : null;
    const lists = modifierSection(me, { recipeId, dishName, dishLines }, d, () => { load(); reloadPage?.(); });
    fill(box, variations,
      lists.length ? [h('div', { class: 'row wrap mod-head' }, h('h2', { class: 'grow', text: 'Modifiers' }),
        h('span', { class: 'small muted', text: `${d.modifierCostPerPlate >= 0 ? '+' : '−'}${dollars(Math.abs(d.modifierCostPerPlate), { cents: true })} a plate on average` })), lists] : null);
  };
  load();
  return box;
}

/** Every modifier list, set once for everything it's sold with. */
async function modifiersScreen(me, from) {
  loadingScreen(me, 'recipes', 'Modifiers');
  const r = await costGet('/api/modifiers', true);
  const again = () => modifiersScreen(me, from);
  if (!r.ok) return show(shell(me, 'recipes', [h('h1', { text: 'Modifiers' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const open = r.data.lists.reduce((a, l) => a + l.modifiers.filter((m) => m.status === 'notSet').length, 0);
  show(shell(me, 'recipes', [
    h('header', { class: 'row wrap' }, h('div', { class: 'grow' }, h('div', { class: 'kicker', text: 'Every item they’re sold with' }), h('h1', { text: 'Modifiers' }),
      h('div', { class: 'sub', text: open ? `${open} not set yet: until they are, what they add isn’t in food cost.` : 'Every modifier is set.' })),
      from ? h('button', { class: 'btn', text: `← ${from.label}`, onclick: () => from.go() }) : null),
    page(modifierSection(me, {}, r.data, again), [sideBox('How modifiers count', h('div', { class: 'small muted', text: 'Each one is set once and counts wherever it’s sold. An item’s cost is its recipe plus what its modifiers add on average, from what was actually picked. “Guessed” ones are read from the name (extra mozzarella: half again the pizza’s cheese): check them once.' }))]),
  ]));
}

/** One card, on its own page in the book. */
async function recipePage(me, name, opts = {}) {
  const r = await api('GET', `/api/recipes/${encodeURIComponent(name)}`);
  const from = opts.from;
  const rail = from?.rail ?? 'recipes';
  if (!r.ok) return show(shell(me, rail, [h('h1', { text: name }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const v = recipeView(me, r.data, { open: (n) => recipePage(me, n, { from }), back: h('button', { class: 'btn', text: `← ${from?.label ?? 'Recipes'}`, onclick: () => (from ? from.go() : recipesScreen(me)) }), page: true, reload: () => refreshInPlace(() => recipePage(me, name, opts)), ...opts });
  show(shell(me, rail, [v.head, page(v.body, v.side)]));
}

/** A card over whatever's on screen (a prep list), so nobody loses their place. */
async function recipeSheet(me, name, scaleTo, trail = []) {
  const q = scaleTo?.amount > 0 && scaleTo.unit ? `?amount=${scaleTo.amount}&unit=${encodeURIComponent(scaleTo.unit)}${scaleTo.grams > 0 ? `&grams=${Math.round(scaleTo.grams)}` : ''}` : '';
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
  let history = null;
  const body = h('div', { class: 'recipe' });
  const side = page ? h('div', { class: 'page-side-boxes' }) : null;
  const makesText = () => (prep ? `Makes ${nice(y.amount * scale)} ${UNIT_LABEL(y.unit)}${r.yields.length > 1 ? ` (${r.yields.slice(1).map((x) => `${nice(x.amount * scale)} ${UNIT_LABEL(x.unit)}`).join(', ')})` : ''}${r.batchGrams && dimensionName(y.unit) !== 'mass' ? `, about ${weightText(r.batchGrams * scale)}` : ''}` : r.kind === 'drink' ? 'One drink' : 'One plate');
  const sellsAs = r.sellsAs.filter((n) => n.toLowerCase() !== r.name.toLowerCase());
  const editButton = r.canEdit && !opts.sheet ? h('button', { class: 'btn', text: 'Edit recipe', onclick: async () => { const d = (await api('GET', '/api/cards')).data; const c = d.cards.find((x) => x.name === r.name); if (c) cardEditor(me, d, c, { back: { label: r.name, go: (saved) => recipePage(me, saved || c.name, opts), rail: opts.from?.rail ?? 'recipes' } }); } }) : null;
  // A new recipe that starts as a copy of this one (a new pizza from the margherita), back here if cancelled.
  const baseButton = r.canEdit && page ? h('button', { class: 'btn', text: 'Use as a base', title: 'Start a new recipe from a copy of this one', onclick: async () => {
    const d = (await api('GET', '/api/cards')).data; const c = d.cards.find((x) => x.name === r.name);
    if (c) cardEditor(me, d, null, { base: c, back: { label: r.name, go: (saved) => recipePage(me, saved || r.name, opts), rail: opts.from?.rail ?? 'recipes' } });
  } }) : null;
  const usedIn = () => (r.usedBy.length ? r.usedBy.map((n, k) => [k ? ', ' : '', h('button', { class: 'linkish card-link', text: n, onclick: () => opts.open(n) })]) : null);
  // The page's title row stays put; only the amounts change with the batch size.
  const head = page ? h('header', { class: 'row wrap' },
    h('div', { class: 'grow' }, h('div', { class: 'kicker', text: `${AREA_NAMES[r.side]} · ${r.section}` }),
      h('div', { class: 'row tight wrap' }, h('h1', { text: r.name }), r.rough ? h('span', { class: 'tag rough', title: 'Still being worked out: cooks don’t see it yet.', text: `Rough${r.toFinish ? ` · ${r.toFinish} to finish` : ''}` }) : null),
      h('div', { class: 'sub', text: [sellsAs.length ? `Sells as ${sellsAs.join(', ')}` : '', r.shelfLifeDays ? `keeps ${r.shelfLifeDays} days` : ''].filter(Boolean).join(' · ') || null })),
    opts.back ?? null, baseButton, editButton) : null;
  const draw = () => {
    const sizes = [0.5, 1, 2, 3];
    const other = r.scaledTo && Math.abs(r.scale - 1) > 1e-6 && !sizes.includes(r.scale);
    const scaler = prep ? h('div', { class: 'seg', role: 'group', 'aria-label': 'How much to make' },
      sizes.map((k) => h('button', { class: Math.abs(scale - k) < 1e-6 ? 'on' : '', 'aria-pressed': String(Math.abs(scale - k) < 1e-6), 'aria-label': `${k} batch${k > 1 ? 'es' : ''}`,
        text: page ? (k === 0.5 ? '½' : String(k)) : k === 0.5 ? '½ batch' : k === 1 ? '1 batch' : `${k} batches`, onclick: () => { scale = k; draw(); } })),
      other ? h('button', { class: Math.abs(scale - r.scale) < 1e-6 ? 'on' : '', text: `For ${nice(r.scaledTo.amount)}${/^\d/.test(UNIT_LABEL(r.scaledTo.unit)) ? ' ×' : ''} ${UNIT_LABEL(r.scaledTo.unit)}`, onclick: () => { scale = r.scale; draw(); } }) : null) : null;
    const asked = r.asked && !r.scaledTo && prep ? h('div', { class: 'note', text: `The list says make ${nice(r.asked.amount)}${/^\d/.test(UNIT_LABEL(r.asked.unit)) ? ' ×' : ''} ${UNIT_LABEL(r.asked.unit)}. This recipe is written in ${UNIT_LABEL(y.unit)}, so it shows one batch.` }) : null;
    const table = h('table', { class: 'ingredients' }, h('tbody', {}, r.ingredients.map((i) => h('tr', {},
      h('td', { class: 'amt', text: i.amount > 0 ? `${nice(i.amount * scale)} ${UNIT_LABEL(i.unit)}` : `– ${UNIT_LABEL(i.unit ?? '')}` }),
      h('td', {}, i.card ? h('button', { class: 'linkish card-link', text: i.card, onclick: () => opts.open(i.card) }) : h('span', { text: i.name }),
        i.yieldPercent ? h('span', { class: 'small muted', text: ` (after trimming; ${i.yieldPercent}% usable)` }) : null,
        i.note ? h('div', { class: 'small muted', text: i.note }) : null)))));
    // Steps, numbered (one per line of the method).
    const method = r.method ? h('div', { class: 'method' }, h('h3', { text: 'Steps' }), h('ol', { class: 'steps-view' }, r.method.split(/\n+/).map((p) => p.trim()).filter(Boolean).map((p) => h('li', { text: p })))) : h('div', { class: 'small muted', text: r.canEdit && !opts.sheet ? 'No steps written yet. Add them with Edit recipe.' : 'No steps written yet.' });
    const cost = r.cost !== undefined ? `Costs ${money2(r.cost * scale)}${r.complete ? '' : ' (some lines have no price yet)'}` : null;
    if (page) {
      fill(body, asked, h('section', { class: 'card' }, h('h2', { text: makesText() }), table), h('section', { class: 'card' }, method));
      fill(side,
        r.image ? h('section', { class: 'card tight' }, photo(r.image, 'hero')) : null,
        prep ? sideBox('How much', h('div', { class: 'big', text: `${nice(y.amount * scale)} ${UNIT_LABEL(y.unit)}` }), scaler, h('div', { class: 'small muted', text: 'Batches: every amount scales with it.' })) : null,
        r.allergens ? allergenSide(r.allergens) : null,
        r.usedBy.length ? sideBox('Used in', h('div', { class: 'small' }, usedIn())) : null,
        r.linked ? soldAsBox(r, opts.reload) : null,
        cost ? sideBox('Cost · managers only', h('div', { class: 'big', text: money2(r.cost * scale) }), h('div', { class: 'small muted', text: `${prep ? `for ${nice(y.amount * scale)} ${UNIT_LABEL(y.unit)}` : r.kind === 'drink' ? 'a drink' : 'a plate'}${r.complete ? '' : ' · some lines have no price yet'}` })) : null,
        r.canEdit && r.sameAs?.length ? sameDishBox(r, (name) => recipePage(me, name, opts)) : null,
        r.canEdit && r.id ? (history ??= recipeHistoryBox(r, (name) => recipePage(me, name, opts))) : null);
      return;
    }
    fill(body,
      h('div', { class: 'row wrap' },
        h('div', { class: 'grow' }, h('div', { class: 'kicker', text: `${AREA_NAMES[r.side]} · ${r.section}` }), h('h2', { class: 'sheet-title', text: r.name }),
          h('div', { class: 'sub', text: [makesText(), sellsAs.length ? `sells as ${r.sellsAs.join(', ')}` : '', r.shelfLifeDays ? `keeps ${r.shelfLifeDays} days` : ''].filter(Boolean).join(' · ') })),
        opts.back ?? null, editButton),
      r.image ? photo(r.image, 'hero') : null,
      scaler, asked, table, method,
      r.allergens ? h('div', { class: 'small' }, h('span', { class: 'muted', text: 'Allergens: ' }), h('span', { class: r.allergens.contains.length ? 'allergy' : '', text: r.allergens.line })) : null,
      r.usedBy.length ? h('div', { class: 'small' }, h('span', { class: 'muted', text: 'Used in ' }), usedIn()) : null,
      cost ? h('div', { class: 'small muted', text: `${cost} · managers only` }) : null);
  };
  draw();
  return page ? { head, body, side: [...side.children].length ? side : null } : body;
}

/** An ingredient's allergens, tagged here once for every recipe that uses it. */
function ingredientAllergens(id) {
  const box = sideBox('Allergens');
  api('GET', '/api/floor/allergen-map').then((r) => {
    if (!r.ok) return box.remove();
    const p = Object.values(r.data.products).find((x) => x.id === id);
    if (!p) return box.remove();
    const draw = () => {
      const tags = p.allergens ?? [];
      fill(box, h('div', { class: 'small muted strong', text: 'Allergens' }),
        h('div', { class: 'row tight' }, h('span', { class: `tag ${p.allergens === null ? 'warn' : 'ok'}`, text: p.allergens === null ? 'not checked' : tags.length ? 'checked' : 'checked: none' })),
        h('div', { class: 'allergy-chips' }, Object.entries(FLOOR_ALLERGENS).map(([key, label]) => {
          const on = tags.includes(key);
          return h('button', { class: `chip${on ? ' on' : ''}`, 'aria-pressed': String(on), text: label, onclick: () => save(on ? tags.filter((x) => x !== key) : [...tags, key]) });
        })),
        p.allergens === null ? h('button', { class: 'link small', text: 'None of these', onclick: () => save([]) }) : null,
        h('div', { class: 'small muted', text: 'Every recipe that uses it follows.' }));
    };
    const save = async (list) => { p.allergens = list; draw(); await api('POST', `/api/floor/ingredients/${encodeURIComponent(id)}`, { allergens: list }); };
    draw();
  });
  return box;
}

/** A recipe's allergens, worked out through every prep in it: what brings each one, and what isn't checked yet. */
function allergenSide(a) {
  return sideBox('Allergens',
    h('div', { class: a.contains.length ? 'allergy big-allergy' : 'strong', text: a.line }),
    a.contains.map((x) => h('div', { class: 'small' }, h('b', { text: `${x.label}: ` }), x.from.join(', '))),
    a.unchecked.length ? h('div', { class: 'small warn-text', text: `Not checked yet: ${a.unchecked.join(', ')}` }) : null,
    a.unknown.length ? h('div', { class: 'small warn-text', text: `Not matched to an ingredient: ${a.unknown.join(', ')}` }) : null,
    (a.swaps ?? []).filter((w) => w.line !== a.line).map((w) => h('div', { class: 'small' }, h('b', { text: `With the ${w.label}: ` }), w.line)));
}

/**
 * Two recipes that look like one dish (a draft made from the POS button, a misspelling): keep one.
 * The other's buttons, uses in other recipes, prep lists and menu answers move to the one kept.
 */
function sameDishBox(r, go) {
  const err = h('div', { class: 'error' });
  const merge = (from, into) => pageAction(async () => {
    if (!confirmText(`Keep “${into}” and take out “${from}”? Its Square buttons, prep lists and anything that used it move to “${into}”. “${from}” stays in the history.`)) return;
    const res = await api('POST', '/api/cards/merge', { from, into });
    if (!res.ok) return (err.textContent = res.data.error ?? 'That didn’t work.');
    go(into);
  });
  return sideBox('Same dish?', r.sameAs.map((other) => h('div', { class: 'stack' },
    h('div', { class: 'small', text: `“${other}” looks like the same dish.` }),
    h('button', { class: 'btn', text: `Keep ${other}`, onclick: () => merge(r.name, other) }),
    h('button', { class: 'btn', text: `Keep ${r.name}`, onclick: () => merge(other, r.name) }))), err);
}

const VERSION_CHANGE = { created: 'Written', edited: 'Changed', renamed: 'Renamed', removed: 'Taken out', restored: 'Put back', imported: 'Brought into the app' };

/** Every saved version of a recipe (managers): who changed it and when; an earlier one can be seen and put back. */
function recipeHistoryBox(r, onRestored) {
  const list = h('div', { class: 'history' }, h('div', { class: 'small muted', text: 'Loading…' }));
  const box = sideBox('History', list);
  (async () => {
    const res = await api('GET', `/api/cards/history?id=${encodeURIComponent(r.id)}`);
    if (!res.ok) return fill(list, h('div', { class: 'small muted', text: 'Couldn’t load the history.' }));
    const versions = res.data.versions ?? [];
    let all = false;
    const draw = () => fill(list,
      versions.length ? null : h('div', { class: 'small muted', text: 'No changes saved yet.' }),
      (all ? versions : versions.slice(0, 6)).map((v, i) => {
        const detail = h('div', { class: 'history-detail' });
        const open = i > 0 && v.change !== 'removed' ? h('button', { class: 'link small', text: 'See this version', onclick: async () => {
          if (detail.childElementCount) { fill(detail); open.textContent = 'See this version'; return; }
          open.textContent = 'Hide';
          const one = await api('GET', `/api/cards/version?id=${encodeURIComponent(v.id)}`);
          if (!one.ok) return fill(detail, h('div', { class: 'error', text: one.data.error ?? 'Couldn’t load it.' }));
          const c = one.data.card;
          const err = h('div', { class: 'error' });
          let sure = false;
          const back = h('button', { class: 'btn small-btn', text: 'Put this version back', onclick: async () => {
            if (!sure) { sure = true; back.textContent = 'Yes, put it back'; return; }
            back.disabled = true;
            const done = await api('POST', '/api/cards/restore', { version: v.id });
            if (!done.ok) { back.disabled = false; return (err.textContent = done.data.error ?? 'Couldn’t put it back.'); }
            onRestored(done.data.name ?? r.name);
          } });
          fill(detail,
            c.name !== r.name ? h('div', { class: 'small strong', text: `Called ${c.name} then` }) : null,
            h('ul', { class: 'small history-lines' }, c.ingredients.map((x) => h('li', { text: `${x.amount > 0 ? `${nice(x.amount)} ${UNIT_LABEL(x.unit)} ` : ''}${x.name}${x.yieldPercent ? ` (${x.yieldPercent}% usable)` : ''}` }))),
            c.method ? h('div', { class: 'small muted', text: `${c.method.split(/\n+/).filter((p) => p.trim()).length} steps` }) : null,
            h('div', { class: 'small muted', text: 'Putting it back saves it as the recipe today; the current one stays in this history.' }),
            back, err);
        } }) : null;
        return h('div', { class: 'history-row' },
          h('div', { class: 'row tight' }, h('span', { class: 'grow small', text: `${i === 0 ? 'Now: ' : ''}${v.dated ? 'Changed from that day' : VERSION_CHANGE[v.change] ?? v.change}${v.by ? ` by ${v.by}` : ''}${v.name && v.name !== r.name ? ` (as ${v.name})` : ''}` }), h('span', { class: 'small muted', text: when(v.at) })),
          open, detail);
      }),
      versions.length > 6 && !all ? h('button', { class: 'link small', text: `All ${versions.length} versions`, onclick: () => { all = true; draw(); } }) : null);
    draw();
  })();
  return box;
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
      h('div', {}, h('button', { class: 'linkish name', text: c.name, onclick: () => cardEditor(me, d, c, { back: returnTo('Recipe costs', () => cardsScreen(me, opts)) }) }),
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
      h('button', { class: 'linkish grow', text: x.name, title: `Write the recipe for ${x.name}`, onclick: () => cardEditor(me, d, null, { name: x.itemName, kind: side === 'bar' ? 'drink' : 'dish', link: [x], back: returnTo('Recipe costs', () => cardsScreen(me, opts)) }) }),
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
    sideActions(h('button', { class: 'btn small-btn dark', text: 'New recipe', onclick: () => cardEditor(me, d, null, { kind: side === 'bar' ? 'drink' : 'dish', back: returnTo('Recipe costs', () => cardsScreen(me, opts)) }) })));
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
/**
 * Recipe checks: what the menu uses every week but hasn't come in on an invoice in far too long
 * (the recipe probably names a product you stopped buying: swap in what you buy now), and what you
 * buy on invoice after invoice that no recipe uses (a recipe may be missing it).
 */
async function recipeChecksScreen(me, opts = {}) {
  const from = opts.from;
  const rail = from?.rail ?? 'recipes';
  loadingScreen(me, rail, 'Recipe checks');
  const side = sideOf(me);
  const r = await api('GET', `/api/cards/checks?area=${side}`);
  if (!r.ok) return show(shell(me, rail, [h('h1', { text: 'Recipe checks' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const d = r.data;
  const again = () => recipeChecksScreen(me, opts);
  const open = (name) => recipePage(me, name, { from: returnTo('Recipe checks', again) });
  const amount = (n) => (n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));
  const recipeLinks = (names) => names.map((n, k) => [k ? ', ' : '', h('button', { class: 'linkish card-link', text: n, onclick: () => open(n) })]);
  const productList = h('datalist', { id: 'check-products' }, d.products.map((p) => h('option', { value: p.name, label: p.lastBought ? `last bought ${shortDate(p.lastBought)}` : 'not bought lately' })));
  // A row that's been answered folds to one line with Undo.
  const settle = (row, said, undo) => {
    const undoBtn = h('button', { class: 'link', text: 'Undo', onclick: () => pageAction(async () => { busy(undoBtn, true); const res = await undo(); if (!res.ok) { busy(undoBtn, false); return undoBtn.after(h('span', { class: 'error small', text: ` ${res.data.error ?? 'Couldn’t undo it.'}` })); } again(); }) });
    fill(row, h('div', { class: 'rcheck-done row tight wrap' }, h('span', { class: 'grow', text: said }), undoBtn));
  };
  const dismiss = (row, key, note, said) => pageAction(async () => {
    const res = await api('POST', '/api/answers', { type: 'dismiss', dedupeKey: key, note });
    if (!res.ok) return row.append(h('div', { class: 'error small', text: res.data.error ?? 'That didn’t save.' }));
    settle(row, said, () => api('POST', '/api/answers/undo', { target: { dedupeKey: key } }));
  });
  const swap = (row, x, to, btn) => pageAction(async () => {
    busy(btn, true);
    const res = await api('POST', '/api/cards/swap', { from: x.productId, to: to.id, recipes: x.recipes });
    if (!res.ok) { busy(btn, false); return row.append(h('div', { class: 'error small', text: res.data.error ?? 'That didn’t save.' })); }
    const { changed, rough } = res.data;
    settle(row, `${to.name} now in ${changed.join(', ')}.${rough.length ? ` ${rough.join(', ')} went back to rough: check the unit on that line.` : ''}`,
      () => api('POST', '/api/cards/swap', { from: to.id, to: x.productId, recipes: changed }));
  });

  const staleRow = (x) => {
    const row = h('article', { class: 'rcheck' });
    const since = x.last ? `Last on an invoice ${shortDate(x.last.date)}${x.last.vendor ? ` (${x.last.vendor})` : ''}, ${x.weeks} weeks ago` : `Not on any invoice we have (${x.weeks} weeks)`;
    const pickIn = h('input', { type: 'text', list: 'check-products', class: 'pick-in', placeholder: 'What you buy instead', 'aria-label': `What replaces ${x.name}` });
    const pickMsg = h('span', { class: 'small error' });
    const pickBox = h('div', { class: 'row tight wrap rcheck-pick', hidden: true }, pickIn,
      h('button', { class: 'btn small-btn dark', text: 'Swap it in', onclick: (e) => {
        const to = d.products.find((p) => p.name.toLowerCase() === pickIn.value.trim().toLowerCase());
        if (!to) return (pickMsg.textContent = 'Pick it from the list as you type.');
        swap(row, x, to, e.currentTarget);
      } }), pickMsg);
    const n = x.recipes.length;
    const swapBtn = x.likely ? h('button', { class: 'btn small-btn dark', text: `Swap it in ${n === 1 ? x.recipes[0] : `${n} recipes`}`, onclick: (e) => swap(row, x, { id: x.likely.productId, name: x.likely.name }, e.currentTarget) }) : null;
    fill(row,
      h('div', { class: 'row wrap' }, h('h3', { class: 'grow', text: x.name }), x.dollarsPerWeek ? h('span', { class: 'small muted', text: `about ${dollars(x.dollarsPerWeek)} a week` }) : null),
      h('div', { class: 'small', text: `The menu uses about ${amount(x.perWeek)} ${UNIT_LABEL(x.unit)} a week (${x.dishes.slice(0, 3).join(', ')}${x.dishes.length > 3 ? ` and ${x.dishes.length - 3} more` : ''}).` }),
      h('div', { class: 'small warn-text', text: `${since}.` }),
      x.recipes.length ? h('div', { class: 'small' }, h('span', { class: 'muted', text: n === 1 ? 'Named in ' : 'Named in these recipes: ' }), recipeLinks(x.recipes)) : null,
      x.likely ? h('div', { class: 'rcheck-likely' }, h('span', { text: 'You’ve been buying ' }), h('b', { text: x.likely.name }),
        h('span', { text: `${x.likely.vendor ? ` from ${x.likely.vendor}` : ''} (${x.likely.times} invoice${x.likely.times === 1 ? '' : 's'}, last ${shortDate(x.likely.lastDate)})${x.likely.inNoRecipe ? ', and no recipe uses it' : ''}. Is that what ${n === 1 ? 'it' : 'they'} should say?` })) : null,
      h('div', { class: 'row tight wrap' }, swapBtn,
        h('button', { class: `btn small-btn${x.likely ? '' : ' dark'}`, text: x.likely ? 'Something else…' : 'Pick what replaces it…', onclick: () => { pickBox.hidden = false; pickIn.focus(); } }),
        h('button', { class: 'btn small-btn', text: 'It’s right as is', onclick: () => dismiss(row, `ingredient:notBought:${x.productId}`, `${x.name}: right as is, though not bought lately`, `${x.name}: kept as is. It won’t be flagged again.`) })),
      pickBox);
    return row;
  };
  const unusedRow = (x) => {
    const row = h('article', { class: 'rcheck' });
    fill(row,
      h('div', { class: 'row wrap' }, h('h3', { class: 'grow', text: x.name }), h('span', { class: 'small muted', text: `${dollars(x.dollars)} in 60 days` })),
      h('div', { class: 'small', text: `On ${x.times} invoices, last ${shortDate(x.lastDate)}${x.vendor ? ` (${x.vendor})` : ''}. No recipe uses it.` }),
      h('div', { class: 'row tight wrap' },
        h('button', { class: 'btn small-btn', text: 'Not for the menu', title: 'Staff meal, cleaning, or something sold as is: stop asking', onclick: () => dismiss(row, `ingredient:notInRecipe:${x.productId}`, `${x.name}: not for the menu`, `${x.name}: not for the menu. It won’t be listed again.`) })));
    return row;
  };
  const quietRow = (v) => {
    const row = h('article', { class: 'rcheck' });
    fill(row,
      h('div', { class: 'row wrap' }, h('h3', { class: 'grow', text: v.vendor }), h('span', { class: 'small warn-text', text: `${v.days} days without an invoice` })),
      h('div', { class: 'small', text: `Last invoice ${dateWithYear(v.lastDate)}. They usually come every ${v.usualGap} day${v.usualGap === 1 ? '' : 's'} (${v.invoices} in the 6 months before). If deliveries are still coming, their invoices aren’t reaching MarginEdge, and food cost reads low until they do.` }),
      h('div', { class: 'row tight wrap' },
        h('button', { class: 'btn small-btn', text: 'We stopped buying from them', onclick: () => dismiss(row, `vendor:quiet:${v.vendorId}:${v.lastDate}`, `${v.vendor}: stopped buying from them`, `${v.vendor}: stopped buying from them. It asks again if they invoice and go quiet again.`) })));
    return row;
  };
  const stale = d.notBought, unused = d.notInRecipes, quiet = d.quietVendors ?? [];
  show(shell(me, rail, [
    h('header', { class: 'row wrap' },
      h('div', { class: 'grow' }, h('div', { class: 'kicker', text: AREA_NAMES[side] }), h('h1', { text: 'Recipe checks' })),
      h('div', { class: 'row wrap' }, sideSwitch(me, again), from ? h('button', { class: 'btn', text: `← ${from.label}`, onclick: () => from.go() }) : null)),
    page([
      productList,
      quiet.length ? h('section', { class: 'card' },
        h('h2', { text: 'Vendors gone quiet' }),
        h('div', { class: 'small muted', text: 'They invoiced regularly, then stopped. Check MarginEdge for their invoices before trusting food cost.' }),
        h('div', { class: 'rchecks' }, quiet.map(quietRow))) : null,
      h('section', { class: 'card' },
        h('h2', { text: 'Used on the menu, not bought lately' }),
        h('div', { class: 'small muted', text: 'Sales run through your recipes say these get used every week, but no invoice has brought them in for far longer than a pack lasts. Usually the recipe names a product you’ve stopped buying.' }),
        stale.length ? h('div', { class: 'rchecks' }, stale.map(staleRow)) : h('div', { class: 'small', text: 'Nothing: everything the menu uses has come in on an invoice lately.' })),
      h('section', { class: 'card' },
        h('h2', { text: 'Bought regularly, in no recipe' }),
        h('div', { class: 'small muted', text: 'On 3 or more invoices in the last 60 days, and no recipe uses it. A recipe may be missing it, or it isn’t for the menu.' }),
        unused.length ? h('div', { class: 'rchecks' }, unused.map(unusedRow)) : h('div', { class: 'small', text: 'Nothing: everything you buy regularly is in a recipe.' })),
    ], [
      sideBox('How it’s checked', h('div', { class: 'small muted', text: 'Each dish still on the menu, times what sold, run down through its recipe to what you buy. A product is flagged when, since its last invoice, the menu would have gone through 3 packs or more (or $40 worth, if it was never bought) and at least 4 weeks have passed. A big bag used a pinch at a time isn’t flagged.' })),
    ]),
  ]));
}

function cardEditor(me, d, card, start = {}) {
  // Where it was opened from is where Back, Cancel and Save return to (Recipe costs unless said).
  const back = start.back ?? { label: 'Recipe costs', go: () => cardsScreen(me), rail: 'menu' };
  const c = card ? JSON.parse(JSON.stringify(card)) : { name: start.name ?? '', kind: start.kind ?? 'dish', yields: [], ingredients: start.ingredients ?? [], linked: start.link ?? [], status: 'rough' };
  if (!c.ingredients.length) c.ingredients.push({ amount: '', unit: '', name: '' });
  const prepKind = () => c.kind === 'prep' || c.kind === 'barPrep';
  if (prepKind() && !c.yields.length) c.yields.push({ amount: '', unit: '' });
  const options = [...d.products.map((p) => ({ id: p.id, name: p.name, units: [...p.units], unit: p.unit, price: p.price, kind: 'product' })), ...d.allCards.filter((x) => x.name !== card?.name).map((x) => ({ name: x.name, units: [...x.units], unit: x.unit, kind: 'card' }))];
  const byName = new Map(options.map((o) => [o.name.toLowerCase(), o]));
  const listId = 'ingredient-options';
  const datalist = h('datalist', { id: listId }, options.map((o) => h('option', { value: o.name, label: o.kind === 'card' ? 'recipe' : UNIT_LABEL(o.unit) })));
  // Units a recipe's yields can be in: the usual ones and your containers; anything else typed is a new one.
  const yieldUnits = ['batch', 'each', 'portion', 'qt', 'pt', 'gal', 'floz', 'cup', 'ml', 'l', 'oz', 'lb', 'g', 'kg'];
  const yieldList = h('datalist', { id: 'yield-units' }, yieldUnits.map((u) => h('option', { value: UNIT_LABEL(u) })));
  api('GET', '/api/units').then((r) => { for (const ct of r.data?.containers ?? []) yieldList.append(h('option', { value: ct.name })); });
  const err = h('div', { class: 'error', role: 'alert' });
  const total = h('div', { class: 'big' });
  const totalNote = h('div', { class: 'small muted' });
  const statusChip = h('span', { class: 'tag' });
  const lines = h('div', { class: 'ilist' });

  // Where a line stands: finished, or what it still needs (rough recipes save either way).
  const GENERIC = ['each', 'g', 'oz', 'lb', 'ml', 'floz', 'tsp', 'tbsp', 'cup', 'qt', 'pinch', 'handful', 'bunch'];
  const stateOf = (i) => {
    if (!i.name) return '';
    const o = byName.get(i.name.toLowerCase());
    if (!o) return 'unmatched';
    if (!(Number(i.amount) > 0)) return 'amount';
    if (!i.unit) return 'unit';
    return o.units.includes(i.unit) ? 'ok' : 'convert';
  };
  const toFinish = () => c.ingredients.filter((i) => i.name && stateOf(i) !== 'ok').length;
  const drawStatus = () => {
    const n = toFinish();
    statusChip.className = `tag ${c.status === 'rough' ? 'rough' : 'ok'}`;
    statusChip.textContent = c.status === 'rough' ? `Rough${n ? ` · ${n} to finish` : ' · every line done'}` : 'Ready';
    statusChip.title = c.status === 'rough' ? 'Still being worked out: managers see it, cooks don’t yet.' : 'Cooks see this recipe.';
    // Every line finished: Mark ready is the next step, so it stands out.
    if (readyBtn) { readyBtn.classList.toggle('dark', !n); saveBtn.classList.toggle('dark', Boolean(n)); }
  };

  let previewTimer;
  const preview = () => {
    drawStatus();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const usable = c.ingredients.filter((i) => i.name);
      const res = await api('POST', '/api/cards/preview', { card: { ingredients: usable } });
      if (!res.ok) return;
      const hints = [...lines.querySelectorAll('.irow-hint')];
      const srcs = [...lines.querySelectorAll('.isrc')];
      const ages = new Set();
      [...lines.querySelectorAll('.icost')].forEach((el, n) => {
        const i = c.ingredients[n];
        const l = res.data.lines[usable.indexOf(i)] ?? {};
        const st = stateOf(i);
        const age = priceAge(l.source);
        const oldPrice = age.level && st === 'ok' && !l.problem && l.cost !== undefined;
        // An old price: where the Price from box is hidden, the cost itself turns yellow or red, and
        // tapping it says why (an iPad has no hover). Where the box shows, the cost stays plain.
        if (oldPrice) { ages.add(age.level); fill(el, whyTip(age.line, { label: money2(l.cost), class: `cost-tap age-${age.level}`, wrapClass: 'cost-tip', aria: `${money2(l.cost)}: why this price may be out of date` })); }
        else el.textContent = l.cost !== undefined && !l.problem ? money2(l.cost) : st && st !== 'ok' ? 'to finish' : l.problem ? 'no cost' : '';
        el.title = l.problem ?? '';
        el.classList.toggle('warn-text', Boolean(l.problem) || (st && st !== 'ok'));
        if (srcs[n]) drawSource(srcs[n], l.source);
        // A finished line that still can't be costed says why, under it (a tooltip never shows on an iPad).
        const hint = hints[n];
        if (!hint || st !== 'ok') return;
        if (st === 'ok' && l.problem) { hint.dataset.cost = '1'; fill(hint, costHint(i, l)); }
        else if (hint.dataset.cost === '1') { delete hint.dataset.cost; fill(hint); }
      });
      // The key to the colours, under the lines, only for the colours in use.
      fill(ageNote,
        ages.has('yellow') ? h('div', { class: 'age-key age-yellow' }, h('i'), h('span', { text: 'Yellow: the price was last paid more than 3 months ago, so it may be out of date.' })) : null,
        ages.has('red') ? h('div', { class: 'age-key age-red' }, h('i'), h('span', { text: 'Red: more than 6 months ago, or MarginEdge’s last price from before the invoices we read. Check it before trusting the cost.' })) : null,
        ages.size ? h('div', { class: 'age-tap-hint muted', text: 'Tap a coloured price to see when and where it was last paid.' }) : null);
      total.textContent = `${money2(res.data.total)}${toFinish() ? '+' : ''}`;
      const y = c.yields.find((x) => Number(x.amount) > 0 && x.unit);
      const per = prepKind() ? (y ? `for ${qty(Number(y.amount))} ${UNIT_LABEL(y.unit)}` : 'for one batch') : `a ${c.kind === 'drink' ? 'drink' : 'plate'}`;
      const price = card?.averagePrice;
      totalNote.textContent = `${per}${price && !prepKind() ? ` · ${pct(res.data.total / price)} of the ${money2(price)} it sells for` : ''}${toFinish() ? ` · ${toFinish()} line${toFinish() === 1 ? '' : 's'} not costed yet` : res.data.complete ? '' : ' · some lines can’t be priced yet'}`;
    }, 250);
  };

  // Why a finished line has no cost: no price for the product (set one here), or a unit that won't convert.
  const costHint = (i, l) => {
    if (l.needsPrice) {
      const p = l.needsPrice;
      const o = byName.get(p.name.toLowerCase());
      return h('span', { class: 'warn-text' }, `No price for ${p.name}: it isn’t on an invoice we’ve read, and MarginEdge has no last price for it. `,
        h('button', { class: 'link', text: 'Set a price', onclick: (e) => priceForm(e.currentTarget.parentElement, p, o) }), ' · ',
        h('button', { class: 'link', text: 'It costs nothing', title: 'Soda from the gun, herbs from the garden: counted at $0', onclick: async () => { const res = await api('POST', '/api/answers', { type: 'price', productId: p.productId, price: 0, amount: 1, unit: p.unit }); if (res.ok) preview(); } }));
    }
    if (l.cantConvert) return h('span', { class: 'warn-text', text: `No cost: ${l.problem}. Try another unit, or set how much one ${UNIT_LABEL(i.unit)} is.` });
    if (l.problem) return h('span', { class: 'warn-text', text: `No cost yet: ${l.problem}.` });
    return null;
  };
  // How old a price is: yellow past 3 months, red past 6 (or MarginEdge's last price, which is older
  // than every invoice we read). `line` says it under the line when the Price from box is hidden.
  const priceAge = (src) => {
    if (src?.from === 'marginedge') return { level: 'red', line: 'MarginEdge’s last price, from before the invoices we read (over 6 months): it may be out of date.' };
    if (!(src?.from === 'invoice' || src?.from === 'manual') || !src.date) return { level: '' };
    const days = (Date.now() - Date.parse(`${src.date}T12:00:00`)) / 86_400_000;
    const level = days > 182 ? 'red' : days > 91 ? 'yellow' : '';
    const what = src.from === 'manual' ? 'Price set by hand' : src.vendor ? `Last paid to ${src.vendor}` : 'Last paid';
    return { level, line: `${what} on ${dateWithYear(src.date)}, over ${level === 'red' ? 6 : 3} months ago: it may be out of date.` };
  };
  const ageNote = h('div', { class: 'age-keys' });
  // Where a line's price comes from, beside its cost: the vendor and invoice date, so a wrong or old
  // price shows while the recipe is being written.
  const drawSource = (el, src) => {
    el.className = 'isrc';
    if (!src) return fill(el);
    const { level } = priceAge(src);
    if (level) el.classList.add(`age-${level}`);
    if (src.from === 'invoice') {
      const age = (Date.now() - Date.parse(`${src.date}T12:00:00`)) / 86_400_000;
      const when = age > 300 ? dateWithYear(src.date) : shortDate(src.date);
      el.title = `${src.vendor ?? 'Invoice'}, ${when}${src.invoices > 1 ? `: the average of ${src.invoices} invoices in the last 60 days, latest shown` : ''}`;
      const vendor = `${src.garden ? '🌱 ' : ''}${(src.vendor ?? 'Invoice').replace(/,?\s+(inc|llc|co|corp|ltd|company)\.?$/i, '').trim()}`;
      if (src.garden) el.title = `From our garden (free), averaged with what was bought in the last 60 days. Latest: ${when}`;
      return fill(el, h('b', { text: vendor }), h('span', { text: `${when}${src.invoices > 1 ? ` · avg of ${src.invoices}` : ''}` }));
    }
    if (src.from === 'free') { el.title = src.manual ? 'Marked as costing nothing' : 'Water, ice and soda water cost nothing'; return fill(el, h('b', { text: 'Free' }), h('span', { text: src.manual ? 'set by hand' : 'costs nothing' })); }
    if (src.from === 'manual') { el.title = 'A price set by hand in the app'; return fill(el, h('b', { text: 'Set by hand' }), src.date ? h('span', { text: shortDate(src.date) }) : null); }
    if (src.from === 'marginedge') { el.title = 'Not on an invoice we’ve read: MarginEdge’s last price, which may be old'; return fill(el, h('b', { text: 'MarginEdge' }), h('span', { text: 'last price' })); }
    el.title = 'Costed from its own recipe’s lines';
    return fill(el, h('span', { text: 'its recipe' }));
  };
  const priceForm = (slot, p, o) => {
    const price = h('input', { inputmode: 'decimal', class: 'short', placeholder: '0.00', 'aria-label': `Price of ${p.name}` });
    const unit = h('select', { 'aria-label': 'Per' }, (o?.units ?? [p.unit]).map((u) => h('option', { value: u, text: UNIT_LABEL(u), selected: u === p.unit ? true : undefined })));
    const msg = h('span', { class: 'small error' });
    const set = async () => {
      const v = parseAmount(price.value.replace('$', ''));
      if (!(v > 0)) return (msg.textContent = 'A price like 1.65');
      const res = await api('POST', '/api/answers', { type: 'price', productId: p.productId, price: v, amount: 1, unit: unit.value });
      if (!res.ok) return (msg.textContent = res.data.error ?? 'Not saved.');
      preview();
    };
    fill(slot, h('span', { class: 'row tight wrap' }, h('span', { text: '$' }), price, h('span', { text: 'per' }), unit,
      h('button', { class: 'btn small-btn dark', text: 'Set', onclick: set }), msg));
    price.focus();
  };

  // Yields: what one batch makes, said every way it's measured (1 batch · 12 qt · 6 kg · 30 balls).
  const yieldBox = h('div', { class: 'yields' });
  const drawYields = () => {
    if (!prepKind()) return fill(yieldBox);
    fill(yieldBox,
      h('div', { class: 'row tight' }, h('span', { class: 'strong', text: 'Yields' }), h('span', { class: 'small muted', text: 'one batch, every way you measure it' })),
      c.yields.map((y, n) => {
        const amt = h('input', { inputmode: 'decimal', class: 'short', value: y.amount === '' ? '' : String(y.amount), 'aria-label': 'Yield amount', placeholder: '0' });
        amt.addEventListener('change', () => { const v = parseAmount(amt.value); y.amount = Number.isNaN(v) ? '' : v; preview(); });
        const unit = h('input', { type: 'text', class: 'yunit', list: 'yield-units', value: UNIT_LABEL(y.unit ?? ''), 'aria-label': 'Yield unit', placeholder: 'batch, qt, kg, ball…' });
        unit.addEventListener('change', () => { y.unit = unit.value.trim() === 'fl oz' ? 'floz' : unit.value.trim(); preview(); });
        return h('div', { class: 'row tight' }, h('span', { class: 'small muted yeq', text: n ? '=' : '' }), amt, unit,
          c.yields.length > 1 ? h('button', { class: 'btn small-btn', 'aria-label': 'Remove this yield', text: '×', onclick: () => { c.yields.splice(n, 1); drawYields(); preview(); } }) : null);
      }),
      h('div', { class: 'row tight wrap' }, h('button', { class: 'btn small-btn', text: '+ Another way to measure it', onclick: () => { c.yields.push({ amount: '', unit: '' }); drawYields(); } }),
        h('span', { class: 'small muted', text: 'A unit you name here (ball, tray) works wherever this recipe is used.' })));
  };

  // A unit of an ingredient (a handful of arugula), set once on the ingredient and used everywhere.
  const newUnitForm = (i, o, slot, preset) => {
    const nameIn = h('input', { type: 'text', class: 'short', value: preset ?? '', placeholder: 'handful', 'aria-label': 'New unit' });
    const amt = h('input', { inputmode: 'decimal', class: 'short', placeholder: 'how much', 'aria-label': 'How much it is' });
    const unit = h('select', { 'aria-label': 'In' }, ['g', 'oz', 'lb', 'kg', 'ml', 'floz', 'tsp', 'tbsp', 'cup', 'qt', 'each'].map((u) => h('option', { value: u, text: UNIT_LABEL(u) })));
    const msg = h('span', { class: 'small error' });
    const done = async () => {
      const name = nameIn.value.trim().toLowerCase();
      if (!name) return (msg.textContent = 'Name the unit (handful, pinch, ball).');
      const v = parseAmount(amt.value);
      if (amt.value.trim() && !(v > 0)) return (msg.textContent = 'An amount like 15 or 1/2, or leave it for later.');
      if (v > 0) {
        const res = await api('POST', '/api/answers', { type: 'conversion', productId: o.id, fact: 'customUnit', unit: name, amount: v, amountUnit: unit.value });
        if (!res.ok) return (msg.textContent = res.data.error);
        if (!o.units.includes(name)) o.units.push(name);
      }
      i.unit = name;
      drawLines(); preview();
    };
    fill(slot, h('div', { class: 'newunit row tight wrap' }, h('span', { class: 'small', text: '1' }), nameIn, h('span', { class: 'small', text: `of ${o.name} =` }), amt, unit,
      h('button', { class: 'btn small-btn dark', text: 'Set', onclick: done }), h('button', { class: 'link', text: 'Cancel', onclick: () => drawLines() }), msg));
    nameIn.focus();
  };

  const unitSelect = (i, slot) => {
    const o = byName.get(String(i.name).toLowerCase());
    let units = o?.units ?? GENERIC;
    // A unit the line already uses stays, even when it doesn't convert yet (the line says so).
    if (i.unit && !units.includes(i.unit)) units = [i.unit, ...units];
    if (!i.unit && o) i.unit = o.kind === 'product' && ['bottle', 'keg', 'gal', 'l'].includes(o.unit) && units.includes('floz') ? 'floz' : o.unit;
    const sel = h('select', { 'aria-label': `Unit for ${i.name || 'ingredient'}` },
      h('option', { value: '', text: 'unit…', selected: !i.unit ? true : undefined }),
      units.map((u) => h('option', { value: u, text: UNIT_LABEL(u) + (o && !o.units.includes(u) ? ' (how much?)' : ''), selected: u === i.unit ? true : undefined })),
      o?.kind === 'product' ? h('option', { value: '__new', text: '+ New unit…' }) : null);
    sel.addEventListener('change', () => {
      if (sel.value === '__new') { sel.value = i.unit ?? ''; return newUnitForm(i, o, slot); }
      i.unit = sel.value; if (i._err?.field === 'unit') markLine(i); drawLines(); preview();
    });
    return sel;
  };

  // A line's problem, shown under it until that line changes (from typing, or from the server on Save).
  const markLine = (i, msg, field) => { i._err = msg ? { msg, field } : undefined; };
  const move = (n, by) => { const m = n + by; if (m < 0 || m >= c.ingredients.length) return; const [x] = c.ingredients.splice(n, 1); c.ingredients.splice(m, 0, x); drawLines(); preview(); };
  const makePrep = async (i) => {
    const res = await api('POST', '/api/cards', { card: { name: i.name, kind: c.kind === 'drink' || c.kind === 'barPrep' ? 'barPrep' : 'prep', yields: [], ingredients: [] } });
    if (!res.ok) return showLineError(i, res.data.error, 'name');
    const o = { name: i.name, units: ['batch', 'each'], unit: 'batch', kind: 'card' };
    options.push(o); byName.set(i.name.toLowerCase(), o); datalist.append(h('option', { value: i.name, label: 'recipe' }));
    if (!i.unit) i.unit = 'batch';
    drawLines(); preview();
  };
  // Allergens: each ingredient tagged once (every recipe that uses it follows); preps bring their own.
  const allergenBox = h('div', { class: 'allergen-edit' });
  let amap = null;
  api('GET', '/api/floor/allergen-map').then((r) => { if (r.ok) { amap = r.data; drawAllergens(); } });
  const setTags = async (p, list) => {
    p.allergens = list; drawAllergens();
    const r = await api('POST', `/api/floor/ingredients/${encodeURIComponent(p.id)}`, { allergens: list });
    if (!r.ok) err.textContent = r.data.error ?? 'The allergens didn’t save.';
  };
  function drawAllergens() {
    if (!amap) return fill(allergenBox);
    const all = new Set(), rows = [], seen = new Set();
    let unchecked = 0;
    for (const i of c.ingredients) {
      const k = String(i.name ?? '').toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const r = byName.get(k)?.kind === 'card' ? amap.recipes[k] : undefined, p = amap.products[k];
      if (r) {
        r.contains.forEach((x) => all.add(x));
        if (r.unchecked.length) unchecked++;
        rows.push(h('div', { class: 'arow' }, h('span', { class: 'aname', text: i.name }),
          h('span', { class: r.contains.length ? 'allergy' : 'small muted', text: r.contains.length ? r.contains.map((x) => FLOOR_ALLERGENS[x]).join(', ') : r.unchecked.length ? '' : 'none' }),
          r.unchecked.length ? h('span', { class: 'small warn-text', text: `not checked in it: ${r.unchecked.join(', ')}` }) : null,
          h('span', { class: 'small muted', text: 'from its recipe' })));
        continue;
      }
      if (!p) continue;
      const tags = p.allergens ?? [];
      tags.forEach((x) => all.add(x));
      if (p.allergens === null) unchecked++;
      rows.push(h('div', { class: 'arow' }, h('span', { class: 'aname', text: i.name }),
        h('span', { class: `tag ${p.allergens === null ? 'warn' : 'ok'}`, text: p.allergens === null ? 'not checked' : 'checked' }),
        h('div', { class: 'allergy-chips' }, Object.entries(FLOOR_ALLERGENS).map(([key, label]) => {
          const on = tags.includes(key);
          return h('button', { type: 'button', class: `chip${on ? ' on' : ''}`, 'aria-pressed': String(on), text: label, onclick: () => setTags(p, on ? tags.filter((x) => x !== key) : [...tags, key]) });
        })),
        p.allergens === null ? h('button', { type: 'button', class: 'link small', text: 'None of these', onclick: () => setTags(p, []) }) : null));
    }
    const labels = Object.entries(FLOOR_ALLERGENS).filter(([k]) => all.has(k)).map(([, l]) => l);
    fill(allergenBox,
      h('div', { class: 'row wrap' }, h('div', { class: 'strong grow', text: 'Allergens' }),
        h('span', { class: labels.length ? 'allergy' : 'small muted', text: labels.length ? labels.join(', ') : unchecked ? '' : 'None of the major allergens' }),
        unchecked ? h('span', { class: 'tag warn', text: `${unchecked} not checked` }) : null),
      h('div', { class: 'small muted', text: 'Tag an ingredient once: every recipe that uses it follows. Preps bring their own.' }),
      rows);
  }
  const drawLines = () => {
    drawAllergens();
    fill(lines, h('div', { class: 'irow head' }, h('div', { text: 'Amount' }), h('div', { text: 'Unit' }), h('div', { text: 'What goes in' }), h('div', { text: 'Price from' }), h('div', { class: 'num', text: 'Cost' }), h('div')),
      c.ingredients.map((i, n) => {
        const amount = h('input', { inputmode: 'decimal', value: i._amountText ?? (i.amount === '' || !(Number(i.amount) > 0) ? '' : String(i.amount)), 'aria-label': 'Amount', placeholder: '0' });
        const note = h('div', { class: 'irow-msg', role: 'alert', text: i._err?.msg ?? '' });
        const hint = h('div', { class: 'irow-hint' });
        const row = h('div', { class: `irow${i._err ? ' bad' : ''}${i._err?.field ? ` bad-${i._err.field}` : ''}` });
        const setBad = (msg, field) => { markLine(i, msg, field); note.textContent = msg ?? ''; row.className = `irow${msg ? ` bad bad-${field}` : ''}`; };
        amount.addEventListener('change', () => {
          const v = parseAmount(amount.value);
          if (Number.isNaN(v)) { i.amount = ''; i._amountText = amount.value; setBad(`Can’t read “${amount.value.trim()}”. Write it as 2, 1.5, 1 1/2 or ½.`, 'amount'); }
          else { i.amount = v; delete i._amountText; setBad(); }
          drawHint(); preview();
        });
        const name = h('input', { type: 'text', list: listId, value: i.name, 'aria-label': 'Ingredient', placeholder: 'Start typing a product or recipe' });
        const unitSlot = h('div', {});
        const extra = h('div', {});
        fill(unitSlot, unitSelect(i, extra));
        name.addEventListener('change', () => {
          i.name = name.value.trim(); const o = byName.get(i.name.toLowerCase()); if (o) i.name = o.name; if (o && !o.units.includes(i.unit)) i.unit = '';
          if (i._err?.field === 'name') markLine(i);
          drawLines(); preview();
        });
        // What a rough line still needs, said where it is (not an error: it saves as rough).
        const drawHint = () => {
          delete hint.dataset.cost;
          const st = stateOf(i), o = byName.get(String(i.name).toLowerCase());
          if (st === 'unmatched') fill(hint, h('span', { text: 'Not matched yet: pick it from the list as you type, or ' }), h('button', { class: 'link', text: 'make it a prep recipe', onclick: () => makePrep(i) }));
          else if (st === 'convert' && o?.kind === 'product') fill(hint, h('span', { class: 'warn-text', text: `No cost yet: ${o.name} is bought by the ${UNIT_LABEL(o.unit)}, and the app doesn’t know how much one ${UNIT_LABEL(i.unit)} of it is. Pick another unit, or ` }), h('button', { class: 'link', text: `set what one ${UNIT_LABEL(i.unit)} is`, onclick: () => newUnitForm(i, o, extra, i.unit) }));
          else if (st === 'convert') fill(hint, h('span', { text: `${o?.name ?? i.name} isn’t measured in ${i.unit} yet: add it to that recipe’s yields.` }));
          else fill(hint);
        };
        drawHint();
        row.append(amount, unitSlot, name, h('div', { class: 'isrc' }), h('div', { class: 'num icost small' }),
          h('div', { class: 'imove' },
            h('button', { class: 'btn small-btn', 'aria-label': `Move ${i.name || 'line'} up`, text: '↑', disabled: n === 0 ? true : undefined, onclick: () => move(n, -1) }),
            h('button', { class: 'btn small-btn', 'aria-label': `Move ${i.name || 'line'} down`, text: '↓', disabled: n === c.ingredients.length - 1 ? true : undefined, onclick: () => move(n, 1) }),
            h('button', { class: 'btn small-btn', 'aria-label': `Remove ${i.name || 'line'}`, text: '×', onclick: () => { c.ingredients.splice(n, 1); drawLines(); preview(); } })));
        return [row, note, hint, extra];
      }),
      h('button', { class: 'btn small-btn', text: '+ Add a line', onclick: () => { c.ingredients.push({ amount: '', unit: '', name: '' }); drawLines(); [...lines.querySelectorAll('.irow:not(.head) input[list]')].pop()?.focus(); } }));
  };
  const nameInput = h('input', { type: 'text', value: c.name, 'aria-label': 'Recipe name', placeholder: 'e.g. Negroni' });
  nameInput.addEventListener('change', () => { c.name = nameInput.value; });
  const kind = h('select', { 'aria-label': 'Kind' }, Object.entries(KIND_NAMES).map(([k, t]) => h('option', { value: k, text: t, selected: k === c.kind ? true : undefined })));
  kind.addEventListener('change', () => { c.kind = kind.value; if (prepKind() && !c.yields.length) c.yields.push({ amount: '', unit: '' }); drawYields(); preview(); });

  // Steps, numbered, in order (kept one per line in the recipe's method).
  const steps = (c.method ?? '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const stepsBox = h('div', { class: 'steps' });

  // A new recipe can start as a copy of another (a new pizza from the margherita): its kind, yields,
  // lines and steps come over; the name and the button that sells it stay this recipe's own.
  const baseNote = h('span', { class: 'small muted' });
  const useBase = (b) => {
    c.kind = b.kind; kind.value = b.kind;
    c.yields = (b.yields ?? []).map((y) => ({ ...y }));
    if (prepKind() && !c.yields.length) c.yields.push({ amount: '', unit: '' });
    c.ingredients = (b.ingredients ?? []).map(({ state, ...i }) => ({ ...i }));
    if (!c.ingredients.length) c.ingredients.push({ amount: '', unit: '', name: '' });
    steps.splice(0, steps.length, ...(b.method ?? '').split(/\n+/).map((x) => x.trim()).filter(Boolean));
    baseNote.textContent = `Copied from ${b.name}. Change what’s different and give it its own name.`;
    drawLines(); drawYields(); drawSteps(); preview();
  };
  const baseOptions = (d.cards ?? []).filter((x) => x.name !== card?.name);
  const baseInput = h('input', { type: 'text', list: 'base-recipes', class: 'base-in', placeholder: 'Pick a recipe to copy', 'aria-label': 'Start from a recipe' });
  baseInput.addEventListener('change', () => {
    const want = baseInput.value.trim().toLowerCase();
    if (!want) return;
    const b = baseOptions.find((x) => x.name.toLowerCase() === want);
    if (!b) { baseNote.textContent = 'Pick one from the list as you type.'; return; }
    const started = c.ingredients.some((i) => i.name) || steps.some((x) => x.trim());
    if (started && !confirmText(`Replace what’s here with a copy of ${b.name}?`)) { baseInput.value = ''; return; }
    useBase(b);
  });
  const basePick = !card && baseOptions.length ? h('div', { class: 'row tight wrap base-pick' },
    h('span', { class: 'small strong', text: 'Start from a recipe' }), baseInput,
    h('datalist', { id: 'base-recipes' }, baseOptions.map((x) => h('option', { value: x.name, label: KIND_NAMES[x.kind] ?? '' }))), baseNote) : null;
  const drawSteps = () => {
    if (!steps.length) steps.push('');
    fill(stepsBox, steps.map((t, n) => {
      const box = h('textarea', { rows: '2', 'aria-label': `Step ${n + 1}`, placeholder: n === 0 ? 'Mix the dry ingredients…' : 'Then…' });
      box.value = t;
      box.addEventListener('change', () => { steps[n] = box.value.replace(/\n+/g, ' ').trim(); });
      const mv = (by) => { const m = n + by; if (m < 0 || m >= steps.length) return; const [x] = steps.splice(n, 1); steps.splice(m, 0, x); drawSteps(); };
      return h('div', { class: 'step' }, h('div', { class: 'stepn', text: String(n + 1) }), box,
        h('div', { class: 'imove' },
          h('button', { class: 'btn small-btn', 'aria-label': `Move step ${n + 1} up`, text: '↑', disabled: n === 0 ? true : undefined, onclick: () => mv(-1) }),
          h('button', { class: 'btn small-btn', 'aria-label': `Move step ${n + 1} down`, text: '↓', disabled: n === steps.length - 1 ? true : undefined, onclick: () => mv(1) }),
          h('button', { class: 'btn small-btn', 'aria-label': `Remove step ${n + 1}`, text: '×', onclick: () => { steps.splice(n, 1); drawSteps(); } })));
    }), h('button', { class: 'btn small-btn', text: '+ Add a step', onclick: () => { steps.push(''); drawSteps(); [...stepsBox.querySelectorAll('textarea')].pop()?.focus(); } }));
  };

  // Buttons that sell it.
  const linkBox = h('div');
  const unlinked = [];
  const drawLinks = () => {
    // Buttons with no recipe first; then ones on another recipe (a draft made from the button, a misspelled one): linking moves them here.
    const mine = (x) => c.linked.some((l) => l.catalogId === x.catalogId && l.name === x.name);
    const elsewhere = (d.cards ?? []).filter((x) => x.name !== card?.name).flatMap((x) => (x.linked ?? []).map((l) => ({ ...l, on: x.name })));
    const pool = [...d.noCard.filter((x) => !mine(x)), ...elsewhere.filter((x) => !mine(x))];
    const pick = h('select', { 'aria-label': 'Link a button' }, h('option', { value: '', text: 'Link a button that sells it…' }),
      pool.map((x, n) => h('option', { value: String(n), text: `${x.name}${x.sold !== undefined ? ` · ${x.sold} sold` : ''}${x.on ? ` · now on ${x.on}` : ''}` })));
    pick.addEventListener('change', () => { if (pick.value) { c.linked.push(pool[Number(pick.value)]); drawLinks(); } });
    fill(linkBox,
      c.linked.length ? h('div', { class: 'list' }, c.linked.map((l, n) => h('div', {}, h('span', { class: 'grow', text: l.name }), l.sold !== undefined ? h('span', { class: 'small muted', text: `${l.sold} sold` }) : null,
        h('button', { class: 'link', text: 'Unlink', onclick: () => { unlinked.push(...c.linked.splice(n, 1)); drawLinks(); } })))) : h('div', { class: 'small muted', text: 'Not linked to a POS button yet.' }),
      c.kind === 'dish' || c.kind === 'drink' ? pick : null);
  };

  // Point at the line: mark it, say what's wrong under it and beside Save, and scroll it into view.
  const showLineError = (i, msg, field) => {
    markLine(i, msg, field); drawLines(); preview();
    err.textContent = msg;
    const n = c.ingredients.indexOf(i);
    const row = lines.querySelectorAll('.irow:not(.head)')[n];
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row?.querySelector(field === 'amount' ? 'input[aria-label="Amount"]' : field === 'unit' ? 'select' : 'input[list]')?.focus({ preventScroll: true });
  };
  // Saving: both buttons grey out and say so until the next page shows (or an error comes back).
  const saveBtn = h('button', { class: 'btn dark', text: 'Save', onclick: () => save(false) });
  // An existing recipe: a fix (past numbers use it too), unless it really changed from today on.
  const changedBox = card ? h('input', { type: 'checkbox', 'aria-describedby': 'changed-help' }) : null;
  const changedRow = card ? h('div', { class: 'changed-row' },
    h('label', { class: 'inline' }, changedBox, 'The recipe changed from today'),
    h('div', { id: 'changed-help', class: 'small muted', text: 'Tick it for a real change (a new dough, a bigger portion): past numbers keep the recipe as it was. Leave it off to fix a mistake: past numbers use the fix too.' })) : null;
  const readyBtn = c.status === 'rough' ? h('button', { class: 'btn', text: 'Mark ready', title: 'Cooks see it from then on. Every line needs to be finished.', onclick: () => save(true) }) : null;
  let saving = false;
  const busy = (on, ready) => {
    saving = on;
    for (const [btn, label, mine] of [[saveBtn, 'Save', !ready], [readyBtn, 'Mark ready', ready]]) {
      if (!btn) continue;
      btn.disabled = on;
      btn.textContent = on && mine ? 'Saving…' : label;
    }
  };
  const save = async (ready) => {
    if (saving) return;
    busy(true, ready);
    try { if (await saveNow(ready) === 'saved') return; } catch (e) { err.textContent = 'That didn’t save. Try again.'; }
    busy(false);
  };
  const saveNow = async (ready) => {
    err.textContent = '';
    const sent = c.ingredients.filter((i) => i.name || i.amount || i._amountText);
    // Caught here, before anything is sent: an amount that couldn't be read.
    const unread = sent.find((i) => i._amountText !== undefined);
    if (unread) return showLineError(unread, `Line ${c.ingredients.indexOf(unread) + 1}${unread.name ? `, ${unread.name}` : ''}: can’t read “${unread._amountText.trim()}”. Write it as 2, 1.5, 1 1/2 or ½.`, 'amount');
    const yields = prepKind() ? c.yields.filter((y) => Number(y.amount) > 0 && y.unit).map((y) => ({ amount: Number(y.amount), unit: y.unit })) : [];
    const body = { card: { name: nameInput.value, kind: c.kind, yields, ingredients: sent.map(({ _err, _amountText, state, ...i }) => ({ ...i, amount: Number(i.amount) > 0 ? Number(i.amount) : 0, unit: i.unit ?? '' })), method: steps.map((x) => x.trim()).filter(Boolean).join('\n'), ...(ready ? { ready: true } : {}) },
      ...(card ? { previousName: card.name } : {}),
      ...(changedBox?.checked ? { changedFromToday: true } : {}),
      link: c.linked.filter((l) => !(card?.linked ?? []).some((x) => x.catalogId === l.catalogId && x.name === l.name)), unlink: unlinked };
    const res = await api('POST', '/api/cards', body);
    if (!res.ok) {
      // The server counts lines among those sent; ours include empty ones, so map it back.
      if (Number.isInteger(res.data.line) && sent[res.data.line]) {
        const i = sent[res.data.line];
        return showLineError(i, res.data.error.replace(/^Line \d+/, `Line ${c.ingredients.indexOf(i) + 1}`), res.data.field);
      }
      err.textContent = res.data.error;
      err.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    await back.go(nameInput.value.trim());
    return 'saved';
  };
  const del = card && !card.usedBy?.length ? h('button', { class: 'link danger', text: 'Delete recipe', onclick: async () => {
    if (!confirmText(`Delete the ${card.name} recipe? Buttons linked to it go back to “selling without a recipe”.`)) return;
    const res = await api('POST', '/api/cards/delete', { name: card.name });
    if (!res.ok) return (err.textContent = res.data.error ?? 'Not deleted.');
    // Back where it was opened from, unless that was this recipe's own page.
    if (back.label === card.name) recipesScreen(me); else back.go();
  } }) : null;

  if (start.base) { useBase(start.base); baseInput.value = start.base.name; }
  drawLines(); drawYields(); drawSteps(); drawLinks(); preview();
  show(shell(me, back.rail, [
    h('header', { class: 'row wrap' },
      h('div', { class: 'grow' }, h('div', { class: 'kicker', text: card ? 'Recipe' : 'New recipe' }), h('div', { class: 'row tight wrap' }, h('h1', { text: card?.name ?? (c.name || 'New recipe') }), statusChip)),
      h('button', { class: 'btn', text: `← ${back.label}`, onclick: () => back.go() })),
    h('div', { class: 'page editor' },
      h('section', { class: 'card page-main' },
        h('div', { class: 'row wrap' }, h('label', { class: 'grow' }, 'Name', nameInput), h('label', {}, 'Kind', kind)),
        basePick,
        yieldBox, yieldList,
        start.note && !card ? h('div', { class: 'note small', text: start.note }) : null,
        datalist, h('div', { class: 'ilist-wrap' }, lines, ageNote),
        allergenBox,
        h('div', { class: 'strong', text: 'Steps' }), stepsBox,
        err,
        changedRow,
        h('div', { class: 'row wrap' },
          saveBtn, readyBtn,
          h('button', { class: 'btn', text: 'Cancel', onclick: () => back.go() }), h('div', { class: 'grow' }), del),
        h('div', { class: 'small muted', text: c.status === 'rough' ? 'Saves as rough: you and managers see it, cooks don’t. Mark it ready when every line is finished.' : 'Ready: cooks see this recipe. If a change leaves a line unfinished, it goes back to rough.' })),
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
        cardEditor(me, d, null, { name: x.name, kind: 'drink', link: x.items.map((i) => ({ ...i, name: i.variationName ? `${i.itemName} (${i.variationName})` : i.itemName })), back: returnTo('Draft bar recipes', () => draftsScreen(me, pours)) });
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
    cards: () => cardsScreen(me), drafts: () => draftsScreen(me), recipeChecks: () => { if (g.side) me.side = g.side; recipeChecksScreen(me, { from: returnTo('Today', () => todayScreen(me)) }); }, scan: () => scanScreen(me, g.scanId), invoices: () => invoicesScreen(me), inventory: () => inventoryList(me, g.listId, 'count'), order: () => orderScreen(me, g.vendorId), orders: () => { if (g.side) { me.side = g.side; me.ordersSide = g.side; } ordersScreen(me); },
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
  const pauseBar = onlinePauseBar();
  let recipeNames = [];
  const itemRow = (i) => {
    const row = h('article', { class: `todo ${TONE_CLASS[i.tone] ?? ''}${i.answers?.length ? ' has-answers' : ''}` });
    const actions = h('div', { class: 'todo-actions' });
    const normal = () => { row.classList.remove('choosing'); fillNormal(); };
    const fillNormal = () => fill(actions,
      (i.answers ?? []).map((a, n) => h('button', { class: `btn small-btn${n === 0 ? ' blue' : ''}`, text: a.label, onclick: () => answer(row, i, a) })),
      i.pick ? h('button', { class: 'btn small-btn', text: 'Another recipe…', onclick: pickRecipe }) : null,
      i.answers?.length ? h('button', { class: 'link', text: `More on ${i.go.to === 'menu' ? 'Menu' : 'its screen'}`, onclick: () => go(i.go) })
        : h('button', { class: 'btn small-btn dark', text: i.button, onclick: () => go(i.go) }),
      i.snooze?.length ? h('button', { class: 'link snooze-link', text: 'Snooze', title: 'Set it aside for a while, just for you', onclick: choose }) : null);
    // Any recipe we have, found by typing: for a button whose recipe has another name (Katahdin Pizza → Katahdin).
    async function pickRecipe() {
      row.classList.add('choosing');
      const input = h('input', { type: 'search', list: `recipes-${i.key}`, placeholder: 'Type the recipe’s name', 'aria-label': 'Recipe' });
      const msg = h('span', { class: 'small error' });
      fill(actions, input, h('datalist', { id: `recipes-${i.key}` }), h('button', { class: 'btn small-btn dark', text: 'Link', onclick: () => {
          const name = recipeNames.find((n) => n.toLowerCase() === input.value.trim().toLowerCase());
          if (!name) return (msg.textContent = 'Pick one from the list as you type.');
          answer(row, i, { label: `It’s ${name}`, body: { type: 'link', ...i.pick, recipe: name } });
        } }), h('button', { class: 'link', text: 'Cancel', onclick: normal }), msg);
      input.focus();
      if (!recipeNames.length) { const r = await api('GET', '/api/recipes'); if (r.ok) recipeNames = [...new Set(['kitchen', 'bar'].flatMap((k) => (r.data[k] ?? []).flatMap((sec) => (sec.cards ?? []).filter((x) => x.kind === 'dish' || x.kind === 'drink').map((x) => x.name))))].sort(); }
      fill(actions.querySelector('datalist'), recipeNames.map((n) => h('option', { value: n })));
    }
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
      pauseBar,
      t.glance ? homeTiles(me, t, side, onSide) : null,
      page([h('div', { class: 'row wrap todo-head' }, h('h2', { class: 'grow', text: 'To do' })),
        h('section', { class: 'todos', 'aria-label': 'To do' }, sections.length ? sections : h('div', { class: 'card small muted', text: asleep.length ? 'All clear, apart from what’s snoozed.' : 'All clear.' }), asleepBox)],
        [quiet, glanceCards(me, t, side, { home: Boolean(t.glance) })]),
    ]));
    errorFor = null;
  }
  draw();
}

/**
 * Pause online orders, on Today for everyone on shift: the cooks see the slam coming. Shows only on
 * nights online ordering is taking orders, or while it's paused. "Rest of tonight" comes back on by
 * itself at midnight, for the next day's orders; Turn off stays off until someone turns it back on.
 */
function onlinePauseBar() {
  const box = h('section', { class: 'card online-pause', hidden: true, 'aria-label': 'Online orders' });
  const draw = (p) => {
    box.hidden = !p.paused && !p.takingOrders;
    const save = async (btn, body) => {
      busy(btn, true);
      const r = await api('POST', '/api/online/pause', body);
      if (!r.ok) { busy(btn, false); return box.append(h('div', { class: 'error small', text: r.data.error ?? 'That didn’t save.' })); }
      draw(r.data);
    };
    const button = (text, body, cls = '', ask) => h('button', { class: `btn small-btn ${cls}`, text, onclick: (e) => (!ask || confirmText(ask)) && save(e.currentTarget, body) });
    if (p.paused) {
      fill(box, h('div', { class: 'grow' },
        h('div', { class: 'strong', text: p.paused.off ? 'Online orders are turned off' : p.paused.tonight ? 'Online orders are paused for tonight' : `Online orders are paused until ${clock12(p.paused.untilTime)}` }),
        h('div', { class: 'small muted', text: `Customers can’t start new orders. Orders already placed still come through.${p.paused.off ? ' They stay off until you turn them back on.' : p.paused.tonight ? ' They turn back on by themselves at midnight, for tomorrow.' : ''}` })),
        h('div', { class: 'row wrap' }, button(p.paused.off ? 'Turn online orders on' : 'Resume online orders', { resume: true }, 'dark'),
          p.paused.off ? null : button('Turn off', { off: true }, '', 'Turn online orders off? They stay off, tonight and the days after, until someone turns them back on here.')));
    } else {
      fill(box, h('div', { class: 'grow' },
        h('div', { class: 'strong', text: 'Online orders are on' }),
        h('div', { class: 'small muted', text: 'Slammed? Pause new online orders for a while.' })),
        h('div', { class: 'row wrap' }, [15, 30, 60].map((m) => button(`Pause ${m} min`, { minutes: m })),
          button('Rest of tonight', { tonight: true }, '', 'Pause online orders for the rest of tonight? They turn back on by themselves at midnight, so customers can order for tomorrow. To keep them off, use Turn off.'),
          button('Turn off', { off: true }, '', 'Turn online orders off? They stay off, tonight and the days after, until someone turns them back on here.')));
    }
  };
  api('GET', '/api/online/pause').then((r) => { if (r.ok) draw(r.data); });
  return box;
}

/** Each tab's color: the edge of its tile on Today, its tag on a to-do, its icon in the rail. */
const TODO_TABS = {
  prep: { name: 'Prep', color: '#2E7D4F', go: (me) => prepHome(me) },
  orders: { name: 'Orders', color: '#A85400', go: (me) => ordersScreen(me) },
  menu: { name: 'Menu', color: '#1F5FA8', go: (me) => menuScreen(me) },
  recipes: { name: 'Recipes', color: '#0E7470', go: (me) => recipesScreen(me) },
  performance: { name: 'Performance', color: '#7A3E9D', go: (me) => marginsScreen(me) },
  reports: { name: 'Reports', color: '#3D3D3D', go: (me) => reportsScreen(me) },
  ideas: { name: 'Ideas', color: '#8C6A00', go: (me) => ideasScreen(me) },
  inventory: { name: 'Inventory', color: '#5B4636', go: (me) => inventoryHome(me) },
  setup: { name: 'Settings', color: '#6B6B6B', go: (me) => home(me) },
};
const todoTab = (i) => ({ inventory: 'inventory', count: 'prep', review: 'prep', work: 'prep', order: 'orders', orders: 'orders', menu: 'menu', cards: 'recipes', drafts: 'recipes', performance: 'performance', settings: 'setup' })[i.go?.to] ?? (i.group === 'costs' ? 'performance' : i.group === 'setup' ? 'setup' : i.group);
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
  // Ideas take a moment to work out: the tile fills in once they're ready.
  tiles.unshift(['ideas', '…', 'Working out what the numbers suggest']);
  const nav = h('nav', { class: 'home-tiles', 'aria-label': 'Each tab at a glance' }, tiles.map(([key, big, line]) => {
    const tab = TODO_TABS[key];
    const tile = h('button', { class: 'home-tile', onclick: () => tab.go(me) },
      h('span', { class: 'tile-name' }, icon(key === 'performance' ? 'margins' : key), tab.name),
      h('span', { class: 'tile-big', text: big }), h('span', { class: 'tile-line small muted', text: line }));
    tile.style.setProperty('--tab', tab.color);
    tile.dataset.tile = key;
    return tile;
  }));
  api('GET', '/api/ideas').then((r) => {
    const tile = nav.querySelector('[data-tile="ideas"]');
    if (!tile) return;
    if (!r.ok) return tile.remove();
    tile.querySelector('.tile-big').textContent = r.data.ideas.length ? `${dollars(r.data.monthly)}/mo` : 'Nothing new';
    tile.querySelector('.tile-line').textContent = r.data.ideas.length ? `${r.data.ideas.length} idea${r.data.ideas.length === 1 ? '' : 's'}, the biggest ${dollars(r.data.ideas[0].monthly)} a month` : 'No ideas right now';
  });
  return nav;
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

// ------------------------------------------------------------------ ideas
// What the numbers suggest doing, biggest money first: each worth a figure a month, with the numbers
// behind it and where to act. Managers and owners only.

const IDEA_KINDS = {
  waste: ['Waste', 'reports'], unused: ['Not in a recipe', 'recipes'], price: ['Price up', 'reports'], vendor: ['Cheaper vendor', 'orders'],
  dish: ['Selling less', 'menu'], foodcost: ['Food cost', 'performance'], labor: ['Labor', 'reports'], prep: ['Prep training', 'prep'],
};
const IDEA_GO = {
  usage: ['See it in Reports', (me, g) => { if (g.area) me.side = g.area; reportsScreen(me, { report: 'usage', preset: 'month' }); }],
  prices: ['Price chart', (me, g) => reportsScreen(me, { report: 'prices', trail: g.productId ? [{ kind: 'product', id: g.productId, name: g.name }] : [] })],
  performance: ['Performance', (me, g) => { if (g.area) me.side = g.area; marginsScreen(me); }],
  menu: ['Menu', (me) => menuScreen(me)],
  hours: ['Sales and labor by hour', (me) => reportsScreen(me, { report: 'hours', preset: 'month' })],
  prep: ['Prep', (me) => prepHome(me)],
  recipes: ['Recipes', (me) => recipesScreen(me)],
};

async function ideasScreen(me, state = {}) {
  loadingScreen(me, 'ideas', 'Ideas');
  const r = await api('GET', '/api/ideas');
  if (!r.ok) return show(shell(me, 'ideas', [h('h1', { text: 'Ideas' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const d = r.data;
  let kind = state.kind ?? 'all';
  const again = () => refreshInPlace(() => ideasScreen(me, { kind }));
  const setAside = (el, idea, status) => pageAction(async () => {
    pressed = null; busy(el, true);
    const res = await api('POST', '/api/ideas/dismiss', { key: idea.key, status });
    if (!res.ok) { busy(el, false); return el.parentNode.append(h('div', { class: 'error small', text: res.data.error ?? 'Not saved.' })); }
    await foldAway(el.closest('.idea'));
    again();
  });
  const card = (i) => {
    const [label, tab] = IDEA_KINDS[i.kind] ?? [i.kind, 'reports'];
    const go = i.go && IDEA_GO[i.go.to];
    const el = h('article', { class: 'idea card' },
      h('div', { class: 'idea-top' },
        h('div', { class: 'grow' }, h('div', { class: 'tab-tag', text: `${label}${i.area ? ` · ${AREA_NAMES[i.area]}` : ''}` }), h('h3', { class: 'idea-title', text: i.title })),
        h('div', { class: 'idea-money' }, h('b', { text: dollars(i.monthly, { exact: true }) }), h('span', { class: 'small muted', text: 'a month' }))),
      h('ul', { class: 'idea-why small' }, i.why.map((w) => h('li', { text: w }))),
      h('div', { class: 'idea-try' }, h('span', { class: 'small muted strong', text: 'Try: ' }), i.suggestion),
      h('div', { class: 'row wrap idea-actions' },
        go ? h('button', { class: 'btn small-btn dark', text: go[0], onclick: () => go[1](me, i.go) }) : null,
        h('button', { class: 'btn small-btn', text: 'Not now', title: 'Back in two weeks', onclick: (e) => setAside(e.currentTarget, i, 'later') }),
        h('button', { class: 'btn small-btn', text: 'Done', title: 'Comes back only if it gets clearly bigger', onclick: (e) => setAside(e.currentTarget, i, 'done') })));
    el.style.setProperty('--tab', TODO_TABS[tab]?.color ?? '#000');
    return el;
  };
  const kinds = Object.keys(IDEA_KINDS).filter((k) => d.ideas.some((i) => i.kind === k));
  function draw() {
    const shown = d.ideas.filter((i) => kind === 'all' || i.kind === kind);
    const chips = h('div', { class: 'chips-row', role: 'tablist', 'aria-label': 'Show' },
      h('button', { class: `chip${kind === 'all' ? ' on' : ''}`, role: 'tab', 'aria-selected': String(kind === 'all'), onclick: () => { kind = 'all'; draw(); } }, 'All', h('span', { class: 'chip-count', text: String(d.ideas.length) })),
      kinds.map((k) => h('button', { class: `chip${kind === k ? ' on' : ''}`, role: 'tab', 'aria-selected': String(kind === k), onclick: () => { kind = k; draw(); } },
        IDEA_KINDS[k][0], h('span', { class: 'chip-count', text: dollars(d.totals[k] ?? 0) }))));
    const pie = drillDonut({ title: 'a month', format: dollars, items: kinds.map((k) => ({ name: IDEA_KINDS[k][0], value: d.totals[k] ?? 0, go: () => { kind = k; draw(); } })) });
    const asideBox = d.setAside.length ? sideBox('Set aside', h('div', { class: 'list compact' }, d.setAside.map((x) => h('div', {},
      h('span', { class: 'grow' }, h('div', { class: 'small', text: x.title || x.key }), h('div', { class: 'small muted', text: `${x.status === 'done' ? 'Done' : `Not now, back ${shortDate(x.until.slice(0, 10))}`}${x.by ? ` · ${x.by}` : ''}` })),
      h('button', { class: 'link', text: 'Bring back', onclick: (e) => pageAction(async () => { busy(e.currentTarget, true); await api('POST', '/api/ideas/dismiss', { key: x.key, status: 'back' }); again(); }) }))))) : null;
    show(shell(me, 'ideas', [
      h('header', { class: 'row wrap' }, h('div', { class: 'grow' },
        h('div', { class: 'kicker', text: d.ideas.length ? `${dollars(d.monthly, { exact: true })} a month across ${d.ideas.length} idea${d.ideas.length === 1 ? '' : 's'}` : 'Nothing new right now' }),
        h('h1', { text: 'Ideas' }),
        h('div', { class: 'sub', text: 'What the numbers suggest doing, the most money first. Each one has held for weeks, not a single day, and says why.' }))),
      d.ideas.length ? chips : null,
      page([...(d.notes ?? []).map((n) => h('div', { class: 'note small', text: n })),
        shown.length ? shown.map(card) : h('section', { class: 'card small muted', text: 'Nothing here right now. As invoices, sales and prep come in, ideas show up when something holds for a few weeks.' })],
        [pie ? sideBox('Where the money is', pie) : null,
          sideBox('How these work', h('div', { class: 'small muted', text: 'Dollars a month at your current buying and sales. Waste compares what was bought against what every dish sold should have used, over two 4-week stretches, so one big delivery doesn’t count. Not now hides one for two weeks; Done hides it unless it gets half again bigger. Only managers and owners see this page.' })),
          asideBox]),
    ]));
  }
  draw();
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
async function costGet(path, fresh = false) {
  if (!fresh && costCache.has(path)) return costCache.get(path);
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
    vendors.length ? lastPrices(hist, d.unit, colorOf) : null,
    d.usedIn.length ? sideBox('Recipes that use it', h('div', { class: 'list compact' }, d.usedIn.map((u) => h('button', { class: 'linkish lrow', onclick: () => go([{ kind: 'recipe', id: u.id, name: u.name }]) }, h('span', { class: 'grow', text: u.name }), h('span', { class: 'chev', text: '›' }))))) : null,
  ];
  return [main, sideBoxes];
}

/** What each vendor last charged for it (cheapest first) and when, with a nudge when we're not buying the cheaper one. */
function lastPrices(hist, unit, colorOf) {
  const now = hist.points.length ? hist.points[hist.points.length - 1].vendor ?? 'Unknown vendor' : undefined;
  const rows = [...hist.vendors].filter((v) => v.lastPerUnit > 0).sort((a, b) => a.lastPerUnit - b.lastPerUnit);
  if (!rows.length) return null;
  const c = hist.cheaper;
  const ago = (days) => days < 45 ? `${days} day${days === 1 ? '' : 's'} ago` : `${Math.round(days / 30)} months ago`;
  const nudge = c ? h('div', { class: `price-nudge${c.saves > 0.5 ? ' odd' : ''}` },
    h('div', { class: 'strong', text: 'Consider switching' }),
    h('div', { class: 'small', text: `${c.vendor} was ${Math.round(c.saves * 100)}% cheaper (${perUnitText(c.perUnit, unit)} vs ${perUnitText(c.currentPerUnit, unit)} from ${c.current}).` }),
    c.saves > 0.5 ? h('div', { class: 'small', text: 'That’s a big gap — check it’s the same product and pack size before switching.' })
      : c.daysOld > 90 ? h('div', { class: 'small muted', text: `That price is from ${ago(c.daysOld)}, so ask for a fresh quote.` }) : null) : null;
  const keyOf = (v) => { const k = h('span', { class: 'lkey' }); k.style.background = k.style.borderColor = colorOf.get(v) ?? OTHER; return k; };
  return sideBox('Last price by vendor', h('div', { class: 'list compact' }, rows.map((v) => h('div', {}, keyOf(v.vendor),
    h('span', { class: 'grow' }, h('div', { text: v.vendor }),
      h('div', { class: 'small muted', text: `${v.vendor === now ? 'Buying now · ' : ''}${dateWithYear(v.last)} · ${dollars(v.lastPackPrice, { cents: true })} for ${v.lastPack}` })),
    h('b', { text: perUnitText(v.lastPerUnit, unit) })))), nudge);
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
  // Orders can show both sides together; that choice is the Orders page's own, so other pages keep theirs.
  const side = me.ordersSide ?? sideOf(me);
  const r = await api('GET', `/api/orders?area=${side}`);
  if (!r.ok) return show(shell(me, 'orders', [h('h1', { text: 'Orders' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const { vendors, recent, today } = r.data;
  const active = vendors.filter((v) => v.active), paused = vendors.filter((v) => !v.active);
  const vendorCard = (v) => {
    const [tag, cls] = v.order ? STATUS_TAG[v.order.status] : ['Not started', ''];
    return h('section', { class: 'card' },
      h('div', { class: 'vendor-row' },
        h('div', {}, h('div', { class: 'row tight wrap' }, h('h2', { text: v.name }), h('span', { class: `tag ${cls}`, text: tag }), side === 'both' && v.side ? h('span', { class: 'tag', text: AREA_NAMES[v.side] }) : null),
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
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Kitchen, bar or both' },
        ['kitchen', 'bar', 'both'].map((a) => h('button', { class: side === a ? 'on' : '', 'aria-pressed': String(side === a), text: a === 'both' ? 'Both' : AREA_NAMES[a], onclick: () => { me.ordersSide = a; if (a !== 'both') me.side = a; ordersScreen(me); } })))),
    page(active.length ? h('div', { class: 'stack' }, active.map(vendorCard)) : h('div', { class: 'card small muted', text: 'No vendors with regular deliveries yet. They appear after a few weeks of invoices.' }),
      [week, status, spendBox(me, side), cutoffs, recentBox, pausedBox,
        sideBox('Invoices typed in', h('div', { class: 'small muted', text: 'The garden, cash and market buys, and vendors not on MarginEdge.' }),
          sideActions(h('button', { class: 'btn', text: '🌱 Log a garden harvest', onclick: () => invoicesScreen(me, { garden: true }) }), h('button', { class: 'btn', text: 'Add an invoice', onclick: () => invoicesScreen(me) })))]),
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

/** Find an ingredient as you type (products only); picking one calls onPick({ id, name, unit, perUnit }). */
function ingredientPick(initial, onPick, onType) {
  const input = h('input', { type: 'text', placeholder: 'Ingredient', 'aria-label': 'Ingredient', autocomplete: 'off', value: initial || '' });
  const pop = h('div', { class: 'search-pop', hidden: true });
  let timer;
  input.addEventListener('input', () => {
    onType?.();
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { pop.hidden = true; return; }
      const res = await costGet(`/api/costs/search?q=${encodeURIComponent(q)}`);
      if (!res.ok || input.value.trim() !== q) return;
      pop.hidden = false;
      // Not on the list yet (a new item on an invoice): add it here.
      const add = h('button', { class: 'linkish lrow', type: 'button', onclick: () => fill(pop, newIngredientForm(q, (p) => { input.value = p.name; pop.hidden = true; onPick(p); })) },
        h('span', { class: 'grow', text: `+ Add “${q}” as a new ingredient` }));
      fill(pop, ...res.data.products.slice(0, 10).map((p) => h('button', { class: 'linkish lrow', type: 'button', onclick: () => { input.value = p.name; pop.hidden = true; onPick(p); } },
        h('span', { class: 'grow', text: p.name }), h('span', { class: 'small muted', text: p.perUnit !== undefined ? perUnitText(p.perUnit, p.unit) : UNIT_LABEL(p.unit) }))), add);
    }, 180);
  });
  const wrap = h('div', { class: 'search-wrap' }, input, pop);
  wrap.set = (name) => { input.value = name; };
  return wrap;
}

/** A new ingredient: its name, what it's counted in, and food or drink. */
function newIngredientForm(name, onAdded) {
  const nameIn = h('input', { type: 'text', value: name, 'aria-label': 'Ingredient name' });
  const unit = h('select', { 'aria-label': 'Counted in' }, [['lb', 'pounds'], ['oz', 'ounces'], ['kg', 'kilograms'], ['g', 'grams'], ['each', 'each'], ['gal', 'gallons'], ['qt', 'quarts'], ['l', 'liters'], ['ml', 'milliliters'], ['floz', 'fl oz']].map(([v, t]) => h('option', { value: v, text: t })));
  const type = h('select', { 'aria-label': 'Kind' }, [['food', 'Food'], ['wine', 'Wine'], ['beer', 'Beer'], ['liquor', 'Liquor'], ['na', 'Non-alcoholic drink'], ['other', 'Supplies, other']].map(([v, t]) => h('option', { value: v, text: t })));
  const err = h('div', { class: 'error' });
  return h('div', { class: 'new-ing' }, h('div', { class: 'small strong', text: 'New ingredient' }), nameIn,
    h('div', { class: 'row tight' }, h('span', { class: 'small muted', text: 'Counted in' }), unit, type), err,
    h('button', { class: 'btn small-btn', type: 'button', text: 'Add it', onclick: async () => {
      const r = await api('POST', '/api/ingredients', { name: nameIn.value, baseUnit: unit.value, type: type.value });
      if (!r.ok) return (err.textContent = r.data.error ?? 'Couldn’t add it.');
      costCache.clear();
      onAdded({ id: r.data.id, name: r.data.name, unit: r.data.unit });
    } }));
}

/** A photo, made small enough to send (long edge 2000 px, JPEG), as { mediaType, data (base64), preview }. */
async function shrinkPhoto(file) {
  if (file.type === 'application/pdf') {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { mediaType: 'application/pdf', data: btoa(bin), preview: null, name: file.name };
  }
  const url = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = no; fr.readAsDataURL(file); });
  const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
  const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const jpeg = c.toDataURL('image/jpeg', 0.85);
  return { mediaType: 'image/jpeg', data: jpeg.split(',')[1], preview: jpeg, name: file.name, ...photoChecks(img) };
}

/**
 * How readable a photo looks before it's sent: sharpness (the spread of a Laplacian over a
 * 1000 px grey copy: text in focus has strong edges, a blurry shot doesn't), whether it's big
 * enough, and a tiny fingerprint to spot the same page added twice.
 */
function photoChecks(img) {
  const scale = Math.min(1, 1000 / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale)), hgt = Math.max(1, Math.round(img.height * scale));
  const c = document.createElement('canvas'); c.width = w; c.height = hgt;
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, hgt);
  const px = ctx.getImageData(0, 0, w, hgt).data;
  const g = new Float32Array(w * hgt);
  for (let i = 0; i < w * hgt; i++) g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  let n = 0, sum = 0, sq = 0;
  for (let y = 1; y < hgt - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, v = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
    n++; sum += v; sq += v * v;
  }
  const sharpness = n ? sq / n - (sum / n) ** 2 : 0;
  // A 16×16 grey fingerprint.
  const f = document.createElement('canvas'); f.width = 16; f.height = 16;
  const fx = f.getContext('2d'); fx.drawImage(img, 0, 0, 16, 16);
  const fp = [...fx.getImageData(0, 0, 16, 16).data].filter((_, i) => i % 4 === 0);
  return { sharpness: Math.round(sharpness), small: Math.min(img.width, img.height) < 800, print: fp };
}
const BLURRY = 60;
const samePrint = (a, b) => a && b && a.reduce((t, v, i) => t + Math.abs(v - b[i]), 0) / a.length < 6;

/**
 * While both run: the app's reading of an invoice against MarginEdge's, line by line. Fills in
 * after the page is up; nothing shows until there's something to compare.
 */
function compareCard() {
  const box = h('section', { class: 'card', hidden: true });
  api('GET', '/api/invoices/compare').then((r) => {
    if (!r.ok || !r.data.invoices) return;
    const d = r.data;
    const pctOf = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');
    box.hidden = false;
    fill(box, h('h2', { text: 'The app against MarginEdge' }),
      h('div', { class: 'small muted', text: 'Invoices both have read: the same ingredient, quantity and total on each line. When these stay high for a few weeks, MarginEdge isn’t needed.' }),
      h('div', { class: 'cmp-score' },
        h('div', {}, h('b', { text: pctOf(d.matching, d.lines) }), h('span', { class: 'small muted', text: `of ${d.lines} lines the same` })),
        h('div', {}, h('b', { text: pctOf(d.totalsMatching, d.invoices) }), h('span', { class: 'small muted', text: `of ${d.invoices} invoice${d.invoices === 1 ? '' : 's'} with the same total` }))),
      h('div', { class: 'list' }, d.list.slice(0, 20).map((x) => h('details', { class: 'cmp-row' },
        h('summary', {}, h('span', { class: 'grow', text: `${x.vendor} · ${shortDate(x.date)}${x.number ? ` · #${x.number}` : ''}` }),
          h('span', { class: `small ${x.matching === x.lines && x.totalsMatch ? 'good-text' : ''}`, text: `${x.matching}/${x.lines} lines${x.totalsMatch ? '' : ` · ${dollars(x.oursTotal, { cents: true })} vs ${dollars(x.theirsTotal, { cents: true })}`}` })),
        x.detail.length ? h('div', { class: 'small' }, x.detail.map((l) => h('div', { class: 'cmp-line' }, h('b', { text: l.name }), ' ',
          h('span', { class: 'muted', text: l.match === 'onlyOurs' ? 'only in the app' : l.match === 'onlyTheirs' ? 'only in MarginEdge' : l.match === 'quantity' ? 'different amount' : 'different total' }),
          h('div', { class: 'muted', text: `App: ${l.ours ? `${qty(l.ours.quantity)} ${UNIT_LABEL(l.ours.unit)}, ${dollars(l.ours.total, { cents: true })}` : '–'} · MarginEdge: ${l.theirs ? `${l.theirs.quantity !== undefined ? `${qty(l.theirs.quantity)} ${UNIT_LABEL(l.theirs.unit)}, ` : ''}${dollars(l.theirs.total, { cents: true })}` : '–'}` })))) : h('div', { class: 'small good-text', text: 'Every line the same.' })))));
  });
  return box;
}

/** Photograph an invoice: one or more pages, then the app reads it. */
function photoCard(me, connected) {
  const pages = [];
  const thumbs = h('div', { class: 'scan-thumbs' });
  const err = h('div', { class: 'error' });
  const read = h('button', { class: 'btn primary', text: 'Read it', disabled: true });
  const picker = h('input', { type: 'file', accept: 'image/*,application/pdf', capture: 'environment', multiple: true, hidden: true, 'aria-label': 'Invoice photo' });
  const draw = () => {
    const blurry = (p) => p.sharpness !== undefined && p.sharpness < BLURRY;
    fill(thumbs, pages.map((p, i) => {
      // Worth a retake: blurry, too small, or the same page already added. A blurry page with a
      // sharper shot of it is the one to drop.
      const better = pages.some((q, j) => j !== i && samePrint(q.print, p.print) && (q.sharpness ?? 0) > (p.sharpness ?? 0) && !blurry(q));
      const twice = pages.slice(0, i).some((q) => samePrint(q.print, p.print) && !blurry(q));
      const warn = better && blurry(p) ? 'Retaken: drop this one' : twice ? 'Same page twice?' : blurry(p) ? 'Looks blurry: retake?' : p.small ? 'Small: closer?' : null;
      return h('div', { class: `scan-thumb${warn ? ' warn' : ''}` }, p.preview ? h('img', { src: p.preview, alt: `Page ${i + 1}` }) : h('div', { class: 'scan-pdf', text: `PDF · ${p.name}` }),
        warn ? h('span', { class: 'tag warn', text: warn }) : h('span', { class: 'small muted', text: `Page ${i + 1}` }),
        h('button', { class: 'link', type: 'button', text: warn && !warn.startsWith('Retaken') ? 'Remove and retake' : 'Remove', onclick: () => { pages.splice(i, 1); draw(); } }));
    }));
    const doubtful = pages.some((p) => (blurry(p) && !pages.some((q) => q !== p && samePrint(q.print, p.print) && !blurry(q))) || p.small);
    read.textContent = doubtful ? 'Read it anyway' : 'Read it';
    read.disabled = !pages.length;
    take.textContent = pages.length ? '+ Another page' : '📷 Photograph an invoice';
  };
  const take = h('button', { class: 'btn', type: 'button', text: '📷 Photograph an invoice', onclick: () => picker.click() });
  picker.addEventListener('change', async () => {
    err.textContent = '';
    for (const f of [...picker.files]) {
      try { pages.push(await shrinkPhoto(f)); } catch { err.textContent = `Couldn’t open ${f.name}.`; }
    }
    picker.value = '';
    draw();
  });
  read.onclick = async () => {
    err.textContent = '';
    // The same page twice goes once: its sharpest shot.
    const send = pages.filter((p, i) => !pages.some((q, j) => j !== i && samePrint(q.print, p.print) && ((q.sharpness ?? 0) > (p.sharpness ?? 0) || ((q.sharpness ?? 0) === (p.sharpness ?? 0) && j < i))));
    const res = await api('POST', '/api/invoices/scan', { pages: send.map((p) => ({ mediaType: p.mediaType, data: p.data })) });
    if (!res.ok) return (err.textContent = res.data.error ?? 'That didn’t send.');
    scanScreen(me, res.data.id);
  };
  return h('section', { class: 'card' },
    h('h2', { text: 'From a photo' }),
    h('div', { class: 'small muted', text: connected ? 'Take a photo of each page (or pick a PDF). The app reads the lines and matches them to your ingredients; you check them beside the photo before anything is priced.' : 'The invoice reader isn’t connected yet: add ANTHROPIC_API_KEY in Render’s settings. You can still type invoices in below.' }),
    thumbs, err, h('div', { class: 'row wrap' }, take, read), picker);
}

const SCAN_FLAG = {
  unsure: ['Hard to read', 'warn'], math: ['Doesn’t add up', 'warn'], noProduct: ['New item: pick the ingredient', 'blue'],
  noAmount: ['How much is one?', 'blue'], priceJump: ['Price changed a lot', 'warn'], credit: ['Credit: not counted', ''],
  handwritten: ['Hand-corrected', 'warn'], alreadyIn: ['Already saved', ''],
};

/** One invoice photo: reading, or read and ready to check beside the photo. */
async function scanScreen(me, id) {
  loadingScreen(me, 'orders', 'Invoice');
  const back = h('button', { class: 'btn', text: '← Invoices', onclick: () => invoicesScreen(me) });
  const load = async () => {
    const r = await api('GET', `/api/invoices/scan/${id}`);
    if (!r.ok) return show(shell(me, 'orders', [h('h1', { text: 'Invoice' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' }), back]));
    const x = r.data;
    const pagesBox = h('div', { class: 'scan-pages' }, [...Array(x.pages).keys()].map((i) => h('a', { href: `/api/invoices/scan/${id}/page/${i + 1}`, target: '_blank', rel: 'noopener' },
      h('img', { src: `/api/invoices/scan/${id}/page/${i + 1}`, alt: `Page ${i + 1}`, loading: 'lazy' }))));
    if (x.status === 'reading') {
      show(shell(me, 'orders', [h('header', {}, h('div', { class: 'kicker', text: 'Invoice photo' }), h('h1', { text: 'Reading…' }), h('div', { class: 'sub', text: 'Usually 20 to 40 seconds. You can leave this page; it’ll be under Photos to check.' })),
        page([h('section', { class: 'card' }, h('div', { class: 'spinner' }))], [sideBox('', pagesBox), sideBox('', sideActions(back))])]));
      setTimeout(() => { if (document.querySelector('.spinner')) load(); }, 2500);
      return;
    }
    if (x.status === 'failed') {
      return show(shell(me, 'orders', [h('header', {}, h('div', { class: 'kicker', text: 'Invoice photo' }), h('h1', { text: 'Couldn’t read it' }), h('div', { class: 'sub', text: x.error ?? '' })),
        page([h('section', { class: 'card' }, h('div', { class: 'row wrap' },
          h('button', { class: 'btn primary', text: 'Try again', onclick: async () => { await api('POST', `/api/invoices/scan/${id}/retry`); load(); } }),
          h('button', { class: 'btn', text: 'Type it in instead', onclick: () => invoicesScreen(me) }),
          h('button', { class: 'link', text: 'Throw it away', onclick: async () => { await api('POST', `/api/invoices/scan/${id}/discard`); invoicesScreen(me); } })))],
        [sideBox('', pagesBox), sideBox('', sideActions(back))])]));
    }
    if (x.status !== 'read') return show(shell(me, 'orders', [h('header', {}, h('div', { class: 'kicker', text: 'Invoice photo' }), h('h1', { text: x.status === 'saved' ? 'Saved' : 'Thrown away' })), page([h('section', { class: 'card small muted', text: x.status === 'saved' ? 'This invoice is in. Its prices are in use.' : 'This photo was thrown away.' })], [sideBox('', pagesBox), sideBox('', sideActions(back))])]));
    renderScan(me, id, x, pagesBox, back);
  };
  load();
}

function renderScan(me, id, x, pagesBox, back) {
  const mt = x.matched, read = x.read;
  const err = h('div', { class: 'error' });
  // Vendor: the one it matched, any other, or a new one.
  const vendorIn = h('input', { type: 'text', value: mt.vendor.name, 'aria-label': 'Vendor' });
  const vendorNote = h('div', { class: 'small muted', text: mt.vendor.how === 'known' ? 'A vendor you buy from.' : 'New vendor: it’ll be added.' });
  const dateIn = h('input', { type: 'date', value: mt.date ?? iso(new Date()), max: iso(new Date()), 'aria-label': 'Date' });
  const numIn = h('input', { type: 'text', value: mt.number ?? '', placeholder: 'Invoice #', 'aria-label': 'Invoice number' });
  const money = (v) => (v === undefined || v === null ? '' : dollars(v, { cents: true }));

  const rows = mt.lines.map((l) => {
    const line = { l, productId: l.productId, include: Boolean(l.productId && l.baseQuantity > 0 && !l.flags.includes('credit') && !l.flags.includes('alreadyIn')) };
    const tags = h('div', { class: 'scan-flags' });
    const qtyIn = h('input', { inputmode: 'decimal', class: 'amount', value: l.baseQuantity > 0 ? String(l.baseQuantity) : '', 'aria-label': 'How much came in' });
    const unitOut = h('span', { class: 'small muted', text: l.baseUnit ? UNIT_LABEL(l.baseUnit) : '' });
    const totalIn = h('input', { inputmode: 'decimal', class: 'amount money-in', value: String(l.read.total), 'aria-label': 'Line total' });
    const keep = h('input', { type: 'checkbox', checked: line.include, 'aria-label': 'Count this line' });
    keep.addEventListener('change', () => { line.include = keep.checked; });
    const pick = ingredientPick(l.productName ?? '', (p) => { line.productId = p.id; line.unit = p.unit; unitOut.textContent = UNIT_LABEL(p.unit); if (!keep.checked && qtyIn.value) { keep.checked = true; line.include = true; } }, () => { line.productId = null; });
    const chips = l.how === 'guess' && l.candidates?.length > 1 ? h('div', { class: 'small scan-alts' }, h('span', { class: 'muted', text: 'Or:' }), l.candidates.slice(1).map((c) => h('button', { class: 'link', type: 'button', text: c.name, onclick: () => { line.productId = c.id; pick.set(c.name); } }))) : null;
    const flags = [...l.flags, ...(l.how === 'guess' ? ['guess'] : [])];
    fill(tags, flags.map((f) => f === 'guess' ? h('span', { class: 'tag blue', text: 'Best guess: check it' }) : h('span', { class: `tag ${SCAN_FLAG[f]?.[1] ?? ''}`, text: f === 'priceJump' && l.was ? `${l.perBase > l.was ? 'Up' : 'Down'} ${Math.round(Math.abs(l.perBase / l.was - 1) * 100)}% (was ${perUnitText(l.was, l.baseUnit)})` : f === 'handwritten' && l.read.handwritten ? `Hand-corrected: ${l.read.handwritten}` : SCAN_FLAG[f]?.[0] ?? f })));
    line.get = () => ({ productId: line.productId, quantity: parseAmount(qtyIn.value), unit: line.unit ?? l.baseUnit, total: parseAmount(totalIn.value), description: l.read.description, itemKey: l.itemKey,
      perQuantity: l.read.quantity ? parseAmount(qtyIn.value) / l.read.quantity : undefined });
    line.row = h('div', { class: `scan-line${flags.length ? ' flagged' : ''}` },
      h('div', { class: 'scan-read' }, keep, h('div', {},
        h('b', { text: l.read.description }),
        h('div', { class: 'small muted', text: [l.read.code ? `#${l.read.code}` : '', `${l.read.quantity} ${l.read.unit ?? ''}`.trim(), l.read.pack, l.read.unitPrice !== undefined ? `@ ${money(l.read.unitPrice)}` : '', `= ${money(l.read.total)}`].filter(Boolean).join(' · ') }))),
      h('div', { class: 'scan-ours' }, pick, chips, h('div', { class: 'row tight' }, h('span', { class: 'small muted', text: 'Came in' }), qtyIn, unitOut, h('span', { class: 'small muted', text: 'for' }), totalIn), tags));
    return line;
  });

  const banners = [
    mt.duplicateOf ? h('div', { class: 'note', text: mt.duplicateOf.source === 'app'
      ? `This invoice is already saved${mt.duplicateOf.number ? ` (#${mt.duplicateOf.number})` : ''}${mt.duplicateOf.date ? `, ${shortDate(mt.duplicateOf.date)}` : ''}. Lines it already has are unticked; saving adds the rest to it, so nothing counts twice.`
      : `MarginEdge already has this invoice${mt.duplicateOf.number ? ` (#${mt.duplicateOf.number})` : ''}${mt.duplicateOf.date ? `, ${shortDate(mt.duplicateOf.date)}` : ''}. Saving compares the two line by line (under Invoices), and the copy you checked is the one that counts: never twice.` }) : null,
    ...(x.samePaper ?? []).map((o) => h('div', { class: 'note warn-note' },
      h('div', { text: `This invoice${mt.number ? ` (#${mt.number})` : ''} was also photographed ${shortDate(o.createdAt.slice(0, 10))} (${o.pages} page${o.pages === 1 ? '' : 's'}) and isn’t saved yet. Are these more pages of it?` }),
      h('button', { class: 'btn small-btn', text: 'Join them and read again', onclick: async () => { const r2 = await api('POST', `/api/invoices/scan/${id}/join`, { into: o.id }); if (r2.ok) scanScreen(me, r2.data.id); else err.textContent = r2.data.error ?? 'Couldn’t join them.'; } }))),
    mt.totalDifference && Math.abs(mt.totalDifference) >= 0.05 ? h('div', { class: 'note warn-note', text: `The lines, tax and charges come to ${money((read.total ?? 0) - mt.totalDifference)}, but the invoice says ${money(read.total)}: ${money(Math.abs(mt.totalDifference))} ${mt.totalDifference > 0 ? 'missing' : 'extra'}. A line may be misread or missing.` }) : null,
    read.notes ? h('div', { class: 'note', text: `On the invoice: ${read.notes}` }) : null,
  ];
  const save = async () => {
    err.textContent = '';
    const name = vendorIn.value.trim();
    const vendor = mt.vendor.key && name === mt.vendor.name ? { key: mt.vendor.key } : { name };
    const lines = rows.filter((r) => r.include).map((r) => r.get());
    if (lines.some((l) => !l.productId)) return (err.textContent = 'Each line you’re counting needs its ingredient.');
    const res = await api('POST', `/api/invoices/scan/${id}/save`, { vendor, date: dateIn.value, number: numIn.value.trim() || undefined, lines });
    if (!res.ok) return (err.textContent = res.data.error ?? 'That didn’t save.');
    costCache.clear();
    invoicesScreen(me);
  };
  const extras = [read.tax ? `Tax ${money(read.tax)}` : '', read.delivery ? `Delivery ${money(read.delivery)}` : '', read.otherCharges ? `Other charges ${money(read.otherCharges)}` : '', read.total !== undefined ? `Total ${money(read.total)}` : ''].filter(Boolean).join(' · ');
  const main = h('section', { class: 'card' },
    h('div', { class: 'row wrap inv-head' }, h('div', {}, vendorIn, vendorNote), dateIn, numIn),
    ...banners,
    h('div', { class: 'small muted', text: 'Each line as printed on the left; on the right, the ingredient and how much came in, in the way you count it. Untick a line to leave it out.' }),
    h('div', { class: 'scan-lines' }, rows.map((r) => r.row)),
    extras ? h('div', { class: 'small', text: extras }) : null,
    err,
    h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', text: mt.duplicateOf?.source === 'app' ? 'Add the new lines' : 'Save', onclick: save }), h('span', { class: 'grow' }),
      h('button', { class: 'link', text: 'Throw it away', onclick: async () => { await api('POST', `/api/invoices/scan/${id}/discard`); invoicesScreen(me); } })));
  show(shell(me, 'orders', [
    h('header', {}, h('div', { class: 'kicker', text: 'Invoice photo · check it' }), h('h1', { text: mt.vendor.name }),
      h('div', { class: 'sub', text: `${rows.filter((r) => r.l.flags.length || r.l.how === 'guess').length} of ${rows.length} lines to look at. Tap the photo to open it full size.` })),
    page([main], [sideBox('', pagesBox), sideBox('', sideActions(back))], { sticky: true }),
  ]));
}

/**
 * Invoices typed into the app: the garden's harvests (free), cash and farmers-market buys, a
 * vendor that isn't on MarginEdge. Each line is an ingredient, how much came in, and what it cost;
 * they price ingredients just like MarginEdge's invoices (the 60-day average of what came in).
 */
async function invoicesScreen(me, opts = {}) {
  loadingScreen(me, 'orders', 'Invoices');
  const r = await api('GET', '/api/invoices');
  if (!r.ok) return show(shell(me, 'orders', [h('h1', { text: 'Invoices' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const { vendors, invoices, scans = [], readerConnected } = r.data;
  const garden = vendors.find((v) => v.kind === 'garden');
  const today = iso(new Date());

  // Who it's from: one of the vendors, or a new one (the garden is a vendor that costs nothing).
  const NEW = '__new', NEW_GARDEN = '__garden';
  const vendorSel = h('select', { 'aria-label': 'Vendor' },
    h('option', { value: '', text: 'Pick a vendor…' }),
    vendors.map((v) => h('option', { value: v.id ? `id:${v.id}` : `me:${v.meId}`, text: v.kind === 'garden' ? `🌱 ${v.name}` : v.name })),
    h('option', { value: NEW, text: '+ A new vendor' }),
    !garden ? h('option', { value: NEW_GARDEN, text: '+ Our garden (free)' }) : null);
  const newName = h('input', { type: 'text', placeholder: 'Vendor name', 'aria-label': 'New vendor name', hidden: true });
  const dateIn = h('input', { type: 'date', value: today, max: today, 'aria-label': 'Date it came in' });
  const numberIn = h('input', { type: 'text', placeholder: 'Invoice # (optional)', 'aria-label': 'Invoice number' });
  const isGarden = () => vendorSel.value === NEW_GARDEN || (garden && vendorSel.value === `id:${garden.id}`);
  const err = h('div', { class: 'error' });
  const lines = h('div', { class: 'inv-lines' });
  const totalOut = h('b', { text: '' });

  const productPicker = (line) => ingredientPick('', (p) => {
    line.product = p;
    if (!line.unit.value) line.unit.value = p.unit;
    line.unitHint.textContent = `counted in ${UNIT_LABEL(p.unit)}`;
    line.qty.focus();
  }, () => { line.product = null; });
  const lineRows = [];
  const addLine = () => {
    const line = { product: null };
    line.qty = h('input', { inputmode: 'decimal', placeholder: 'How much', 'aria-label': 'How much', class: 'amount' });
    line.unit = h('input', { type: 'text', placeholder: 'unit', 'aria-label': 'Unit', class: 'unit-in', list: 'inv-units' });
    line.total = h('input', { inputmode: 'decimal', placeholder: '$ total', 'aria-label': 'Line total', class: 'amount money-in' });
    line.unitHint = h('span', { class: 'small muted' });
    line.total.addEventListener('input', sum);
    line.row = h('div', { class: 'inv-line' }, productPicker(line), line.qty, line.unit, line.total,
      h('button', { class: 'link', type: 'button', 'aria-label': 'Remove this line', text: '✕', onclick: () => { line.row.remove(); lineRows.splice(lineRows.indexOf(line), 1); sum(); } }), line.unitHint);
    lineRows.push(line);
    lines.append(line.row);
    return line;
  };
  function sum() {
    const t = lineRows.reduce((a, l) => a + (parseAmount(l.total.value) || 0), 0);
    totalOut.textContent = isGarden() ? 'Free: from our garden' : t ? `Total ${dollars(t, { cents: true })}` : '';
  }
  const fit = () => {
    newName.hidden = vendorSel.value !== NEW;
    numberIn.hidden = isGarden();
    for (const l of lineRows) l.total.hidden = isGarden();
    sum();
  };
  vendorSel.addEventListener('change', fit);
  addLine();
  if (opts.garden) vendorSel.value = garden ? `id:${garden.id}` : NEW_GARDEN;
  fit();

  const save = async () => {
    err.textContent = '';
    const v = vendorSel.value;
    const vendor = v.startsWith('id:') ? { id: v.slice(3) } : v.startsWith('me:') ? { meId: v.slice(3) } : v === NEW ? { name: newName.value } : v === NEW_GARDEN ? { name: 'Our garden', kind: 'garden' } : null;
    if (!vendor) return (err.textContent = 'Who is it from?');
    const body = { vendor, date: dateIn.value, ...(numberIn.value.trim() && !isGarden() ? { number: numberIn.value.trim() } : {}),
      lines: lineRows.filter((l) => l.product || l.qty.value).map((l) => ({ productId: l.product?.id ?? '', quantity: parseAmount(l.qty.value), unit: l.unit.value.trim(), total: isGarden() ? 0 : parseAmount(l.total.value) })) };
    const res = await api('POST', '/api/invoices', body);
    if (!res.ok) return (err.textContent = res.data.error ?? 'That didn’t save.');
    costCache.clear();
    invoicesScreen(me);
  };

  const form = h('section', { class: 'card' },
    h('h2', { text: opts.garden ? 'Log a garden harvest' : 'Add an invoice' }),
    h('div', { class: 'small muted', text: 'Each line: the ingredient, how much came in, and what it cost. From the garden it’s free, so leave out the money: it brings the ingredient’s average price down while the garden’s producing.' }),
    h('div', { class: 'row wrap inv-head' }, vendorSel, newName, dateIn, numberIn),
    h('datalist', { id: 'inv-units' }, ['lb', 'oz', 'g', 'kg', 'each', 'bunch', 'qt', 'gal', 'l', 'ml', 'floz', 'case'].map((u) => h('option', { value: u }))),
    lines,
    h('div', { class: 'row wrap' }, h('button', { class: 'btn small-btn', type: 'button', text: '+ Another line', onclick: () => { addLine(); fit(); } }), h('span', { class: 'grow' }), totalOut),
    err,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', text: 'Save', onclick: save })));

  const list = h('section', { class: 'card' }, h('h2', { text: 'Typed in so far' }),
    invoices.length ? h('div', { class: 'list' }, invoices.map((inv) => {
      const remove = h('button', { class: 'link', text: 'Remove' });
      const row = h('div', { class: 'inv-row' },
        h('div', { class: 'grow' },
          h('div', {}, h('b', { text: `${inv.kind === 'garden' ? '🌱 ' : ''}${inv.vendorName}` }), h('span', { class: 'small muted', text: ` · ${shortDate(inv.date)}${inv.number ? ` · #${inv.number}` : ''}` })),
          h('div', { class: 'small muted', text: inv.lines.map((l) => `${qty(l.quantity)} ${UNIT_LABEL(l.unit)} ${l.name}${inv.kind === 'garden' ? '' : ` ${dollars(l.total, { cents: true })}`}`).join(' · ') })),
        h('span', { class: 'small', text: inv.kind === 'garden' ? 'free' : dollars(inv.total, { cents: true }) }), remove);
      // Two taps to take one out, no pop-up.
      remove.onclick = async () => {
        if (remove.textContent !== 'Sure?') { remove.textContent = 'Sure?'; setTimeout(() => { if (remove.isConnected) remove.textContent = 'Remove'; }, 4000); return; }
        const res = await api('DELETE', `/api/invoices/${inv.id}`);
        if (res.ok) { costCache.clear(); row.remove(); }
      };
      return row;
    })) : h('div', { class: 'small muted', text: 'Nothing typed in yet.' }));

  const waiting = scans.length ? h('section', { class: 'card' }, h('h2', { text: 'Photos to check' }),
    h('div', { class: 'list' }, scans.map((x) => h('button', { class: 'linkish lrow', onclick: () => scanScreen(me, x.id) },
      h('span', { class: 'grow', text: x.vendor || 'Invoice photo' }),
      h('span', { class: `small ${x.status === 'failed' ? 'error-text' : 'muted'}`, text: x.status === 'reading' ? 'reading…' : x.status === 'failed' ? 'couldn’t read' : `ready to check · ${shortDate(x.createdAt.slice(0, 10))}` }))))) : null;
  show(shell(me, 'orders', [
    h('header', {}, h('div', { class: 'kicker', text: 'Orders' }), h('h1', { text: 'Invoices' }),
      h('div', { class: 'sub', text: 'Photograph an invoice for the app to read, or type one in. MarginEdge still reads your regular invoices for now.' })),
    page([photoCard(me, readerConnected), waiting, compareCard(), form, list], [sideBox('', sideActions(h('button', { class: 'btn', text: '← Orders', onclick: () => ordersScreen(me) })))]),
  ]));
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
  // A button stays greyed until its whole job is done (save, then approve), so a second tap can't start it again.
  const once = (fn) => async (e) => { const b = e.currentTarget; if (b.disabled) return; b.disabled = true; try { await fn(); } finally { b.disabled = false; } };

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
        status === 'approved' ? h('button', { class: 'link', text: 'Reopen to change', onclick: once(async () => { if (await act('reopen', order.id)) orderScreen(me, vendorId, d.delivery); }) }) : null),
      h('div', { class: 'small muted', text: v.method ? `${v.name} takes orders by ${v.method}${v.contact ? `: ${v.contact}` : ''}.` : 'Add how this vendor takes orders under Vendor settings.' }),
      pre,
      h('div', { class: 'row wrap' }, email, textMsg, copy, h('button', { class: 'btn', text: 'Print', onclick: () => window.print() }),
        status === 'approved' ? h('button', { class: 'btn dark', text: 'Mark as sent', onclick: once(async () => { if (await act('sent', order.id)) orderScreen(me, vendorId, d.delivery); }) }) : null));
  }

  const settingsBox = vendorSettings(me, d, () => orderScreen(me, vendorId, d.delivery));
  const [tag, cls] = STATUS_TAG[status] ?? ['New', ''];
  drawTotal();
  // The order's total and what to do with it sit on the right, beside the lines.
  const totalSide = h('section', { class: 'card tight order-side' },
    h('div', { class: 'row' }, h('div', { class: 'grow small muted strong', text: editable ? 'This order' : 'Ordered' }), h('span', { class: `tag ${cls}`, text: tag })),
    totalBox, err,
    sideActions(
      editable ? h('button', { class: 'btn dark', text: 'Approve order', onclick: once(async () => { const o = await save(); if (o && await act('approve', o.id)) orderScreen(me, vendorId, d.delivery); }) }) : null,
      editable ? h('button', { class: 'btn', text: 'Save draft', onclick: once(async () => { if (await save()) orderScreen(me, vendorId, d.delivery); }) }) : null,
      editable ? h('button', { class: 'btn', text: 'Update suggestions', title: 'Saves the counts and works the suggestions out again', onclick: once(async () => { if (await save()) orderScreen(me, vendorId, d.delivery); }) }) : null,
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

/** How much of the menu's sales has a full cost behind it, as a pie; any slice (or the button) opens what's missing. */
function coverageCard(me, c, side) {
  const total = c.complete + c.gaps + c.noCard;
  if (!total) return null;
  const open = () => { if (side !== 'all') me.side = side; coverageScreen(me); };
  const pie = drillDonut({ title: 'fully costed', format: dollars, centre: { big: `${Math.round((c.complete / total) * 100)}%`, label: 'fully costed' },
    items: [['Fully costed', c.complete, '#000'], ['Missing a price', c.gaps, '#B45A00'], ['No recipe yet', c.noCard, OTHER]].map(([name, value, color]) => ({ name, value, color, ...(name === 'Fully costed' ? {} : { go: open }) })) });
  return h('section', { class: 'card tight cov-card' },
    h('div', { class: 'small muted strong', text: `Menu with full costs, last 90 days${side === 'all' ? '' : ` · ${AREA_NAMES[side]}`}` }),
    pie,
    h('div', { class: 'small muted', text: [c.gapCount ? `${c.gapCount} price${c.gapCount === 1 ? '' : 's'} to fill in` : '', c.noCardCount ? `${c.noCardCount} item${c.noCardCount === 1 ? '' : 's'} without a recipe` : ''].filter(Boolean).join(' · ') || 'Everything is costed.' }),
    sideActions(h('button', { class: 'btn small-btn', text: 'See what’s missing', onclick: open })));
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
      h('button', { class: 'btn small-btn', text: 'Write recipe', onclick: () => cardEditor(me, cards.data, null, { name: x.itemName, kind: side === 'bar' ? 'drink' : 'dish', link: [x], back: returnTo('Recipe coverage', () => coverageScreen(me)) }) }),
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

// ------------------------------------------------------------------ units

const VOLUME_CHOICES = [['floz', 'fl oz', 29.5735295625], ['cup', 'cups', 236.5882365], ['qt', 'qt', 946.352946], ['gal', 'gal', 3785.411784], ['ml', 'ml', 1], ['l', 'l', 1000]];
/** A volume for display: quarts from a quart up, fl oz below. */
const volumeText = (ml) => (ml >= 946 ? `${Math.round((ml / 946.352946) * 10) / 10} qt` : `${Math.round(ml / 29.5735295625)} fl oz`);

/**
 * Units: the fixed conversions (they never change), and the containers everyone shares, edited here. A
 * container's size is what it holds of a liquid; each prep item's own weight in it is set on its list.
 */
async function unitsScreen(me, back) {
  loadingScreen(me, 'settings', 'Units');
  const r = await api('GET', '/api/units');
  if (!r.ok) return show(shell(me, 'settings', [h('h1', { text: 'Units' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const d = r.data;
  const manager = atLeast(me.roleLevel, 'manager');
  const again = () => refreshInPlace(() => unitsScreen(me, back));
  const err = h('div', { class: 'error', role: 'alert' });
  const sizeInputs = (ml) => {
    const unit = h('select', { 'aria-label': 'Unit', class: 'fit' }, VOLUME_CHOICES.map(([k, label]) => h('option', { value: k, text: label })));
    const best = ml >= 700 ? 'qt' : 'floz'; // pans in quarts (a 1/9 holds 0.9), delis and bottles in fl oz
    unit.value = best;
    const per = VOLUME_CHOICES.find(([k]) => k === best)[2];
    const amt = h('input', { inputmode: 'decimal', class: 'amount', value: ml ? String(Math.round((ml / per) * 100) / 100) : '', placeholder: '?', 'aria-label': 'Holds' });
    return { amt, unit, ml: () => { const v = Number(amt.value); return amt.value.trim() === '' ? null : v > 0 ? v * VOLUME_CHOICES.find(([k]) => k === unit.value)[2] : NaN; } };
  };
  const saveContainer = async (el, body) => {
    busy(el, true);
    const res = await api('POST', '/api/units/containers', body);
    if (!res.ok) { busy(el, false); return (err.textContent = res.data.error ?? 'Not saved.'); }
    again();
  };
  const row = (c) => {
    const name = h('input', { type: 'text', value: c.name, 'aria-label': 'Container name' });
    const aliases = h('input', { type: 'text', value: c.aliases.join(', '), placeholder: 'other names, comma between', 'aria-label': 'Other names' });
    const size = sizeInputs(c.volumeMl);
    const note = h('input', { type: 'text', value: c.note ?? '', placeholder: 'e.g. 4" deep', 'aria-label': 'Note', class: 'short' });
    const save = h('button', { class: 'btn small-btn', text: 'Save', onclick: () => {
      const ml = size.ml();
      if (Number.isNaN(ml)) return (err.textContent = 'What it holds, more than 0.');
      saveContainer(save, { id: c.id, name: name.value, aliases: aliases.value, volumeMl: ml, note: note.value });
    } });
    const del = h('button', { class: 'link danger', text: 'Remove', onclick: async (e) => { if (!confirmText(`Remove ${c.name}? Items using it keep their own weights.`)) return; busy(e.currentTarget, true); await api('POST', `/api/units/containers/${c.id}/delete`); again(); } });
    if (!manager) return h('div', { class: 'unit-row' }, h('b', { text: c.name }), h('span', { class: 'small muted', text: c.aliases.join(', ') }), h('span', { text: c.volumeMl ? volumeText(c.volumeMl) : '–' }), h('span', { class: 'small muted', text: c.note ?? '' }));
    return h('div', { class: 'unit-row' }, name, aliases, h('span', { class: 'row tight' }, h('span', { class: 'small muted', text: 'holds' }), size.amt, size.unit), note, h('span', { class: 'row tight' }, save, del));
  };
  const add = (() => {
    const name = h('input', { type: 'text', placeholder: 'New container, e.g. 1/9 pan 6"', 'aria-label': 'New container' });
    const size = sizeInputs(undefined);
    const btn = h('button', { class: 'btn dark small-btn', text: 'Add', onclick: () => {
      if (!name.value.trim()) return;
      const ml = size.ml();
      if (Number.isNaN(ml)) return (err.textContent = 'What it holds, more than 0.');
      saveContainer(btn, { name: name.value, aliases: '', volumeMl: ml });
    } });
    return h('div', { class: 'row wrap' }, name, h('span', { class: 'small muted', text: 'holds' }), size.amt, size.unit, btn);
  })();
  const fixed = (title, rows) => sideBox(title, h('div', { class: 'list compact' }, rows.map(([a, b]) => h('div', {}, h('b', { text: a }), h('span', { class: 'grow right small', text: `= ${b}` })))));
  show(shell(me, 'settings', [
    h('header', { class: 'row wrap' }, h('div', { class: 'grow' }, h('div', { class: 'kicker', text: 'Settings' }), h('h1', { text: 'Units and containers' }),
      h('div', { class: 'sub', text: 'Weight is the base: everything is worked out in grams. Containers keep names straight; each prep item’s weight in its container is set on its list (Edit list).' })),
      back ? h('button', { class: 'btn', text: '← Back', onclick: back }) : null),
    page([err, h('section', { class: 'card' }, h('h2', { text: 'Containers' }),
      h('div', { class: 'small muted', text: 'Sizes are typical; pans vary by maker, so check yours. A size is what it holds of a liquid: a full 1/9 pan of lettuce weighs far less than one of marinara, which is why each item gets its own weight.' }),
      h('div', { class: 'unit-list' }, d.containers.map(row)), manager ? add : null)],
    [fixed('Volume · fixed', d.fixed.volume), fixed('Weight · fixed', d.fixed.weight),
      sideBox('Ounces', h('div', { class: 'small', text: 'fl oz is volume (a 2 oz pour); oz is weight (2 oz of prosciutto). They’re only the same for water. The app keeps them apart.' }))]),
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
  const unitsCard = h('section', { class: 'card' }, h('div', { class: 'row wrap' }, h('h2', { class: 'grow', text: 'Units and containers' }), h('button', { class: 'btn small-btn', text: 'Open', onclick: () => unitsScreen(me, () => home(me)) })),
    h('div', { class: 'small muted', text: 'The fixed conversions, and the containers everyone shares (1/9 pan, deep 1/9 pan, deli quart, Cambros…).' }));
  const main = manager ? [await teamCard(me), unitsCard, await areasCard(), await deviceCard(), await importCard(), await prepImportCard()] : [h('div', { class: 'card small muted', text: 'Nothing to set up here yet.' })];
  const side = [you, manager ? await syncCard('square') : null, manager ? await syncCard('marginedge') : null, await passwordCard(me), ownPinCard(me), canAdminister(me) ? brandCard(me) : null];
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

// Your own password, for signing in by email. The email rides along (hidden) so the browser's
// password manager saves the new one under the right account.
async function passwordCard(me) {
  if (!atLeast(me.roleLevel, 'manager')) return null;
  const r = await api('GET', '/api/me');
  const account = r.ok ? r.data.account : undefined;
  if (!account?.email) return null;
  const box = h('section', { class: 'card', 'aria-label': 'Your password' });
  if (!account.hasPassword) {
    fill(box, h('h2', { text: 'Your password' }), h('div', { class: 'small muted', text: 'You don’t have a password yet. The owner can send you an invite link from Team.' }));
    return box;
  }
  const draw = (note) => fill(box,
    h('h2', { text: 'Your password' }),
    h('div', { class: 'small muted', text: `For signing in with ${account.email} on a phone or computer.` }),
    note ?? null,
    h('div', { class: 'row' }, h('button', { class: 'btn', text: 'Change my password', onclick: openForm })));
  const openForm = () => {
    const err = h('div', { class: 'error', role: 'alert' });
    const save = h('button', { class: 'btn dark', type: 'submit', text: 'Save new password' });
    const form = h('form', { class: 'pass-form', onsubmit: async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(form));
        err.textContent = '';
        if (f.password !== f.again) return (err.textContent = 'The two new passwords don’t match.');
        if (String(f.password).length < 10) return (err.textContent = 'Use at least 10 characters.');
        save.disabled = true;
        const s = await api('POST', '/api/me/password', { current: f.current, password: f.password });
        save.disabled = false;
        if (!s.ok) return (err.textContent = s.data.error ?? 'That didn’t work.');
        draw(h('div', { class: 'small', role: 'status' }, h('span', { class: 'tag ok', text: 'Saved' }), ' Use it next time you sign in. Other phones and computers signed in with the old one are signed out.'));
      } },
      h('input', { type: 'email', name: 'username', value: account.email, autocomplete: 'username', readonly: true, hidden: true, tabindex: '-1', 'aria-hidden': 'true' }),
      h('label', {}, 'Current password', h('input', { type: 'password', name: 'current', required: true, autocomplete: 'current-password' })),
      h('label', {}, 'New password (10 characters or more)', h('input', { type: 'password', name: 'password', required: true, minlength: '10', autocomplete: 'new-password' })),
      h('label', {}, 'New password again', h('input', { type: 'password', name: 'again', required: true, minlength: '10', autocomplete: 'new-password' })),
      err,
      h('div', { class: 'row wrap' }, save, h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => draw() })));
    fill(box, h('h2', { text: 'Your password' }), form);
    form.querySelector('input[name=current]').focus();
  };
  draw();
  return box;
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
        await makeIcon();
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
  const box = h('section', { class: 'card', 'aria-label': 'iPads' });
  const draw = async (message) => {
    const r = await api('GET', '/api/devices');
    const stations = r.data.stations ?? [];
    const posts = r.data.posts ?? [];
    const devices = r.data.devices ?? [];
    // What an iPad is for: a kitchen station's prep, or a front-of-house post's board.
    const stationSelect = (d, label) => {
      const value = d?.floorPostId ? `post:${d.floorPostId}` : d?.stationId ? `station:${d.stationId}` : '';
      return h('select', { 'aria-label': label },
        h('option', { value: '', text: 'Kitchen: any station' }),
        stations.map((s) => h('option', { value: `station:${s.id}`, text: `Kitchen: ${s.name}`, selected: `station:${s.id}` === value ? true : undefined })),
        posts.map((p) => h('option', { value: `post:${p.id}`, text: `Service: ${p.name}`, selected: `post:${p.id}` === value ? true : undefined })));
    };
    const purpose = (v) => ({ stationId: v.startsWith('station:') ? v.slice(8) : null, floorPostId: v.startsWith('post:') ? v.slice(5) : null });
    const err = h('div', { class: 'error' });
    const here = devices.find((d) => d.thisOne);
    const name = h('input', { type: 'text', placeholder: 'e.g. Pizza station iPad', 'aria-label': 'Name for this iPad', required: true });
    const station = stationSelect(null, 'What this iPad is for');
    const form = here ? null : h('form', { class: 'row wrap', onsubmit: async (e) => {
        e.preventDefault();
        const s = await api('POST', '/api/devices', { name: name.value, ...purpose(station.value) });
        if (!s.ok) return (err.textContent = s.data.error ?? 'That didn’t work.');
        draw(h('div', { class: 'note', text: s.data.device?.floorPostId ? `This iPad is set up as “${name.value}”. Sign out, and it shows its post’s board.` : `This iPad is set up as “${name.value}”. Sign out, and cooks will see their names here.` }));
      } }, h('div', { class: 'grow' }, name), stations.length || posts.length ? station : null, h('button', { class: 'btn dark', type: 'submit', text: 'Set up this iPad' }));
    const rows = devices.map((d) => {
      const pick = stationSelect(d, `What ${d.name} is for`);
      pick.addEventListener('change', async () => {
        const s = await api('POST', `/api/devices/${d.id}`, purpose(pick.value));
        if (!s.ok) err.textContent = s.data.error ?? 'That didn’t work.';
      });
      return h('div', { class: 'wrap' },
        h('div', { class: 'grow' }, h('div', { text: d.name + (d.thisOne ? ' (this one)' : '') }), h('div', { class: 'small muted', text: d.lastSeen ? `Last used ${when(d.lastSeen)}` : 'Not used yet' })),
        stations.length || posts.length ? pick : null,
        h('button', { class: 'btn', text: 'Remove', onclick: async () => {
          if (!confirmText(`Remove “${d.name}”? Anyone signed in on it is signed out, and it needs setting up again to use.`)) return;
          await api('POST', `/api/devices/${d.id}`, { revoke: true });
          draw();
        } }));
    });
    fill(box, 
      h('h2', { text: 'iPads' }),
      h('div', { class: 'small muted', text: 'Set up each iPad once, signed in as a manager on it. In the kitchen, cooks sign in with their name and PIN; give it a station and they go straight to that station’s prep list. On the floor (a POS iPad), pick its post: it shows that post’s board with no sign-in.' }),
      rows.length ? h('div', { class: 'list' }, rows) : null,
      form, err, message ?? null,
    );
  };
  await draw();
  return box;
}


// ================================================================== the Floor
// The front of house's board on each POS iPad: tonight's book for that room, what's new and special,
// the gelato flight, what to talk up, managers' notes and checklists, and a lookup for what's in a
// dish, its allergens, and the wines. No sign-in: a PIN only to take credit, or for a manager to change things.

const FLOOR_ALLERGENS = { milk: 'Dairy', egg: 'Egg', wheat: 'Gluten', soy: 'Soy', peanut: 'Peanut', treenut: 'Tree nut', sesame: 'Sesame', fish: 'Fish', shellfish: 'Shellfish', allium: 'Allium' };
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const usd = (p) => `$${Number(p) % 1 ? Number(p).toFixed(2) : Number(p)}`;
const upFirst = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
const resTime = (t) => { const [hh, mm] = String(t).split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')}`; };
const nowMinutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const minutesOf = (t) => { const [hh, mm] = String(t).split(':').map(Number); return hh * 60 + mm; };
/** "Oct 7, 2026, 4:18 PM" or an ISO time → "4:18 PM". */
const asOfText = (v) => { const m = String(v ?? '').match(/\d{1,2}:\d{2}\s?[AP]M/i); if (m) return m[0].toUpperCase(); const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
const fileToBase64 = (file) => new Promise((done, fail) => { const fr = new FileReader(); fr.onload = () => done(String(fr.result).split(',')[1] ?? ''); fr.onerror = fail; fr.readAsDataURL(file); });

let floorRefresh = null, floorIdle = null;
const stopFloorTimers = () => { clearTimeout(floorRefresh); floorRefresh = null; };

/** A dialog over the board: pick your name, then a PIN. Resolves with { staffId, pin, name }, or null. */
function floorPin({ title, why, managersOnly = false }) {
  return new Promise(async (done) => {
    const r = await api('GET', '/api/floor/staff');
    const people = (r.data.staff ?? []).filter((p) => !managersOnly || p.manager);
    const close = (v) => { wrap.remove(); done(v); };
    const panel = h('div', { class: 'floor-modal-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    const wrap = h('div', { class: 'floor-modal', onclick: (e) => { if (e.target === wrap) close(null); } }, panel);
    const names = () => fill(panel,
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('h2', { text: title }), why ? h('div', { class: 'small muted', text: why }) : null), h('button', { class: 'btn', text: 'Cancel', onclick: () => close(null) })),
      people.length ? h('div', { class: 'names' }, people.map((p) => h('button', { onclick: () => pad(p), text: p.name })))
        : h('div', { class: 'note', text: managersOnly ? 'No manager has a PIN yet. Set one in Settings → Your PIN.' : 'Nobody has a PIN yet. A manager sets them in Settings.' }));
    const pad = (person) => {
      let pin = '';
      const dots = h('div', { class: 'dots', 'aria-label': 'PIN entered' });
      const err = h('div', { class: 'error', role: 'alert' });
      const draw = () => fill(dots, ...Array.from({ length: Math.max(4, pin.length) }, (_, i) => h('span', { class: i < pin.length ? 'on' : '' })));
      const press = (d) => { if (pin.length < 6) { pin += d; err.textContent = ''; draw(); } };
      const go = () => { if (pin.length < 4) return (err.textContent = 'At least 4 digits.'); close({ staffId: person.id, pin, name: person.name }); };
      draw();
      fill(panel,
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'kicker', text: why ? `${title}: ${why}` : title }), h('h2', { text: person.name })), h('button', { class: 'btn', text: '← Not you', onclick: names })),
        dots, err,
        h('div', { class: 'pinpad' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => h('button', { onclick: () => press(d), text: d })),
          h('button', { onclick: () => { pin = pin.slice(0, -1); draw(); }, 'aria-label': 'Delete', text: '⌫' }), h('button', { onclick: () => press('0'), text: '0' }), h('button', { class: 'go', onclick: go, text: 'Go' })));
    };
    names();
    document.body.append(wrap);
  });
}

/** Something the board asks for with a PIN (a tick, a note): asks, sends, and says if it went wrong. */
async function floorWithPin(title, why, send) {
  for (;;) {
    const who = await floorPin({ title, why });
    if (!who) return null;
    const r = await send(who);
    if (r.ok) return r;
    const again = await floorMessage(r.data.error ?? 'That didn’t work.', r.status === 403 ? 'Try again' : 'OK');
    if (!again || r.status !== 403) return null;
  }
}
function floorMessage(text, button = 'OK') {
  return new Promise((done) => {
    const wrap = h('div', { class: 'floor-modal' }, h('div', { class: 'floor-modal-panel narrow', role: 'alertdialog' },
      h('p', { text }), h('div', { class: 'row' }, h('button', { class: 'btn dark', text: button, onclick: () => { wrap.remove(); done(true); } }), button !== 'OK' ? h('button', { class: 'btn', text: 'Cancel', onclick: () => { wrap.remove(); done(false); } }) : null)));
    document.body.append(wrap);
  });
}

/** The board. ctx: { me } (signed in) and/or { device } (this iPad's post); { post } to look at another. */
async function floorBoard(ctx = {}) {
  stopFloorTimers();
  const manager = Boolean(ctx.me && atLeast(ctx.me.roleLevel, 'manager'));
  const inShell = manager && !ctx.me.device?.floorPostId;
  if (inShell) loadingScreen(ctx.me, 'floor', 'Service');
  const r = await api('GET', `/api/floor/board${ctx.post ? `?post=${encodeURIComponent(ctx.post)}` : ''}`);
  if (!r.ok) {
    const msg = h('div', { class: 'panel' }, h('h1', { text: 'Service' }), h('p', { text: r.data.error ?? 'Couldn’t load the board.' }),
      manager ? h('button', { class: 'btn dark', text: 'Set it up', onclick: () => floorManage(ctx.me) }) : h('button', { class: 'btn', text: 'Manager sign in', onclick: () => floorManagerSignIn() }),
      h('button', { class: 'btn', text: 'Try again', onclick: () => floorBoard(ctx) }));
    return inShell ? show(shell(ctx.me, 'floor', [msg])) : show(stage(msg));
  }
  const b = r.data;
  const minutes = b.minutes ?? nowMinutes();  // the restaurant's clock, not this iPad's
  const phase = b.phase;
  const reload = () => floorBoard(ctx);

  // --- the head: post, night, search
  const search = h('input', { type: 'search', class: 'floor-search', placeholder: 'Look up a dish, a wine, an ingredient…', 'aria-label': 'Look up' });
  search.addEventListener('input', () => { if (search.value.trim().length >= 2) floorLookup(b, search.value.trim()); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter' && search.value.trim()) floorLookup(b, search.value.trim()); });
  const dateText = new Date(`${b.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const head = h('header', { class: 'floor-head' },
    inShell ? null : h('div', { class: 'floor-logo' }, brandMark('rail')),
    h('div', { class: 'grow' }, h('div', { class: 'kicker', text: dateText }), h('h1', { text: b.post.name })),
    search,
    h('button', { class: 'btn', text: 'Allergies', onclick: () => floorAllergyFinder(b) }),
    b.lookup.wines.length ? h('button', { class: 'btn', text: 'Wines', onclick: () => floorWines(b) }) : null,
    floorTasksButton(b, reload),
    b.post.stationId ? h('button', { class: 'btn', text: 'Bar prep', onclick: async () => { stopFloorTimers(); const d = await api('GET', '/api/devices/staff'); if (d.ok) pinNames(d.data); } }) : null,
    manager && b.posts?.length > 1 ? h('select', { class: 'tool-select', 'aria-label': 'Post', onchange: (e) => floorBoard({ ...ctx, post: e.target.value }) }, b.posts.map((p) => h('option', { value: p.id, text: p.name, selected: p.id === b.post.id ? true : undefined }))) : null,
    manager ? h('button', { class: 'btn dark', text: 'Manage', onclick: () => floorManage(ctx.me) }) : h('button', { class: 'btn', text: 'Manager', onclick: () => floorManagerSignIn() }),
    manager && !inShell ? h('button', { class: 'btn', text: 'Done', title: 'Sign out: back to the board', onclick: async () => { await api('POST', '/api/logout'); start(); } }) : null);

  // --- tonight to know: what's hard to pick out of OpenTable, by what matters most
  const bk = b.book;
  const reasonOf = (x) => x.dietary ?? x.celebration ?? (x.vip ? (x.vipNote ?? 'Regular') : x.suggestRegular ? `Often here: ${x.visitsLastYear} visits last year` : [x.requests, x.notes].filter(Boolean).join(' · ') || `Party of ${x.partySize}`);
  const groupOf = (x) => x.dietary ? 'diet' : x.celebration ? 'celebrate' : x.vip || x.suggestRegular ? 'regular' : x.requests || x.notes || x.partySize >= 6 ? 'request' : null;
  const GROUPS = [['diet', 'Allergies & diet'], ['celebrate', 'Celebrating'], ['regular', 'Regulars'], ['request', 'Requests & big parties']];
  const knowBox = h('section', { class: 'card floor-know' });
  if (!bk) fill(knowBox, h('h2', { text: 'Tonight to know' }), h('div', { class: 'small muted', text: manager ? 'No OpenTable report yet tonight. Upload the CSV export or the pre-shift digest under Manage.' : 'No OpenTable report yet tonight. A manager uploads it.' }));
  else {
    const rows = bk.reservations.map((x) => ({ x, g: groupOf(x) })).filter((r) => r.g);
    fill(knowBox,
      h('div', { class: 'row wrap' }, h('h2', { class: 'grow', text: 'Tonight to know' }), h('span', { class: 'small muted', text: `OpenTable ${bk.source === 'csv' ? 'export' : 'digest'} · as of ${asOfText(bk.asOf)}` })),
      h('div', { class: 'floor-stats' },
        h('div', {}, h('b', { text: String(b.post.kind === 'host' ? bk.covers : bk.mineCovers) }), h('span', { text: ` covers${b.post.kind === 'host' ? '' : ' here'} · ${b.post.kind === 'host' ? bk.parties : bk.mineParties} ${(b.post.kind === 'host' ? bk.parties : bk.mineParties) === 1 ? 'party' : 'parties'}` })),
        bk.busiest ? h('div', {}, h('span', { text: 'Busiest ' }), h('b', { text: `${((bk.busiest.hour + 11) % 12) + 1}–${((bk.busiest.hour + 12) % 12) + 1}` })) : null),
      rows.length ? GROUPS.filter(([k]) => rows.some((r) => r.g === k)).map(([k, label]) => h('div', { class: `know-group ${k}` },
        h('div', { class: 'know-label', text: label }),
        rows.filter((r) => r.g === k).map(({ x }) => h('button', { class: `know-row${phase !== 'pre' && minutesOf(x.time) < minutes - 30 ? ' past' : ''}`, onclick: () => floorGuest(x, manager) },
          h('span', { class: 'res-time', text: resTime(x.time) }),
          h('span', { class: 'res-table', text: x.tables.join('+') || '–' }),
          h('span', { class: 'res-size', text: String(x.partySize) }),
          h('span', { class: 'know-main' }, h('span', { class: 'strong' }, x.vip ? h('span', { class: 'star', text: '★ ' }) : null, x.name), h('span', { class: 'know-why', text: reasonOf(x) })),
          h('span', { class: 'chev', text: '›' })))))
        : h('div', { class: 'small muted', text: 'Nothing special to know about tonight’s guests here.' }));
  }

  // --- the narrow column: specials, new, gelato, notes
  const specials = b.featured.filter((f) => f.kind === 'special');
  const newOnes = b.lookup.dishes.filter((d) => d.isNew);
  const special = specials.length || b.talk.length ? sideBox(specials.length ? 'Specials' : 'Talk it up',
    specials.map((f) => h('button', { class: 'mini-row', onclick: () => f.id && floorDish(b, f.id) },
      h('span', { class: 'grow' }, h('span', { class: 'strong', text: f.name }), h('span', { class: 'allergy small', text: f.allergyLine })), f.price ? h('span', { text: usd(f.price) }) : null)),
    specials.length && b.talk.length ? h('div', { class: 'small muted talk-line', text: `Talk up: ${b.talk.map((t) => t.name).join(', ')}` }) : null,
    !specials.length ? h('div', { class: 'small', text: b.talk.map((t) => t.name).join(', ') }) : null) : null;
  const newBox = newOnes.length ? h('button', { class: 'card tight new-button', onclick: () => floorNewDishes(b) },
    h('span', { class: 'grow' }, h('span', { class: 'small muted strong', text: 'New on the menu' }), h('span', { text: newOnes.map((d) => d.name).join(', ') })),
    h('span', { class: 'tag blue', text: `${newOnes.length} · browse & quiz` })) : h('button', { class: 'card tight new-button', onclick: () => floorQuiz(b, 'all') }, h('span', { class: 'grow small strong', text: 'Quiz me on the menu' }), h('span', { class: 'chev', text: '›' }));
  const gelato = b.gelato ? sideBox('Gelato flight',
    h('div', { class: 'gelato-mini' }, b.gelato.flavors.map((f) => h('span', {}, f.name, f.vegan ? h('span', { class: 'v', text: ' (v)' }) : null))),
    b.gelato.panChanges.map((p) => h('div', { class: 'small strong', text: `${p.size ? `${p.size} ` : ''}${p.from} → ${p.to}` }))) : null;
  const notes = b.notes.length ? sideBox('From the managers', b.notes.map((n) => h('div', { class: 'floor-note' }, h('div', { text: n.body }), n.by ? h('div', { class: 'small muted', text: n.by }) : null))) : null;

  const body = h('div', { class: 'floor-board' }, h('div', { class: 'floor-main' }, knowBox), h('aside', { class: 'floor-side' }, notes, special, newBox, gelato));
  if (inShell) show(shell(ctx.me, 'floor', [head, body]));
  else show(h('div', { class: 'floor' }, head, body));

  // Fresh every two minutes (new check-offs, another report), unless a dialog is open or they've gone elsewhere.
  const again = () => { floorRefresh = setTimeout(() => {
    if (!document.body.contains(body)) return;
    if (document.querySelector('.sheet-wrap, .floor-modal') || document.activeElement?.tagName === 'TEXTAREA' || document.activeElement === search) return again();
    reload();
  }, 120000); };
  again();
  if (manager && !inShell) floorIdleSignOut();
}

/** Tasks, behind one button: what's due now shows on it (opening before 5, the slow list in service, closing after). */
function floorTasksButton(b, reload) {
  const c = b.checklists;
  if (!c.opening.length && !c.closing.length && !c.slow.length) return h('button', { class: 'btn', text: 'Tasks', onclick: () => floorTasks(b, reload) });
  const due = b.phase === 'pre' ? c.opening.filter((x) => !x.done).length : b.phase === 'closing' ? c.closing.filter((x) => !x.done).length : c.slow.filter((x) => x.due).length;
  return h('button', { class: `btn${due ? ' due' : ''}`, text: due ? `Tasks · ${due}` : 'Tasks ✓', onclick: () => floorTasks(b, reload) });
}

/** Opening, closing, "when it's slow" (a PIN for the credit), and a note for the managers. */
function floorTasks(b, reload) {
  const box = h('div', { class: 'stack' });
  let board = b;
  const fresh = async () => { const r = await api('GET', `/api/floor/board?post=${encodeURIComponent(board.post.id)}`); if (r.ok) { board = r.data; draw(); } };
  const tick = (item, slow) => h('button', { class: `check-row${item.done ? ' done' : ''}`, onclick: async () => {
      const res = await floorWithPin(item.done ? 'Undo' : 'Done', item.name, (who) => api('POST', '/api/floor/check', { checklistId: item.id, staffId: who.staffId, pin: who.pin, ...(item.done ? { undo: true } : {}) }));
      if (res) fresh();
    } }, h('span', { class: 'box', 'aria-hidden': 'true', text: item.done ? '✓' : '' }), h('span', { class: 'grow', text: item.name }),
    item.done ? h('span', { class: 'small muted', text: `${item.done.by ?? ''} ${new Date(item.done.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` }) : null,
    slow ? h('span', { class: `small ${item.due ? 'warn-text' : 'muted'}`, text: item.last ? `last ${shortDate(item.last.day)}${item.last.by ? ` · ${item.last.by}` : ''}` : 'not done yet' }) : null);
  const handoffText = h('textarea', { rows: 3, placeholder: 'Guest feedback, something broken, what ran low…', 'aria-label': 'Note for the managers' });
  const draw = () => {
    const c = board.checklists;
    const order = board.phase === 'closing' ? ['closing', 'slow', 'opening'] : board.phase === 'service' ? ['slow', 'closing', 'opening'] : ['opening', 'slow', 'closing'];
    const lists = { opening: ['Opening', c.opening, false], closing: ['Closing', c.closing, false], slow: ['When it’s slow', c.slow.map((x) => ({ ...x, done: null })), true] };
    fill(box, order.map((k) => { const [title, items, slow] = lists[k]; return items.length ? h('section', { class: 'card tight' }, h('h3', { text: title }), slow ? h('div', { class: 'small muted', text: 'Pick one up when it’s quiet: whoever does it gets the credit.' }) : null, h('div', { class: 'checks' }, items.map((x) => tick(x, slow)))) : null; }),
      !c.opening.length && !c.closing.length && !c.slow.length ? h('div', { class: 'muted', text: 'No tasks set up yet. A manager adds them in Service → Setup.' }) : null,
      h('section', { class: 'card tight' }, h('h3', { text: 'Note for the managers' }), h('div', { class: 'small muted', text: 'At the end of the night: they see it in Today.' }), handoffText,
        h('button', { class: 'btn', text: 'Send', onclick: async () => {
          if (!handoffText.value.trim()) return;
          const res = await floorWithPin('Send the note', 'So the managers know who wrote it.', (who) => api('POST', '/api/floor/handoff', { staffId: who.staffId, pin: who.pin, body: handoffText.value }));
          if (res) { handoffText.value = ''; floorMessage(`Sent. Thanks, ${res.data.by}.`); }
        } })));
  };
  draw();
  const s = floorSheet('Tasks', h('h2', { class: 'sheet-title', text: 'Tasks' }), box);
  // The board behind catches up when the sheet closes.
  new MutationObserver((_, o) => { if (!document.body.contains(s.panel)) { o.disconnect(); reload(); } }).observe(document.body, { childList: true });
}

/** One reservation, all of it: notes, requests, history. */
function floorGuest(x, manager) {
  floorSheet(x.name,
    h('div', { class: 'kicker', text: `${resTime(x.time)} · ${x.tables.join('+') || 'no table yet'} · ${x.partySize} ${x.partySize === 1 ? 'guest' : 'guests'}` }),
    h('h2', { class: 'sheet-title' }, x.vip ? h('span', { class: 'star', text: '★ ' }) : null, x.name),
    x.dietary ? h('div', { class: 'note warn-note', text: x.dietary }) : null,
    x.occasions?.length ? h('div', {}, x.occasions.map((o) => h('span', { class: 'tag blue', text: o }))) : null,
    [['Regular', x.vipNote], ['Asked for', x.requests], ['Notes', x.notes]].filter(([, v]) => v).map(([k, v]) => h('section', { class: 'card tight' }, h('div', { class: 'small muted strong', text: k }), h('div', { text: v }))),
    x.visitsLastYear || x.lastVisit || x.spendPerCover ? h('div', { class: 'small muted', text: [x.visitsLastYear ? `${x.visitsLastYear} visit${x.visitsLastYear === 1 ? '' : 's'} last year` : '', x.lastVisit ? `last here ${shortDate(x.lastVisit)}` : '', x.spendPerCover ? `about $${Math.round(x.spendPerCover)} a guest` : ''].filter(Boolean).join(' · ') }) : null,
    x.suggestRegular && manager ? h('div', { class: 'small warn-text', text: 'Comes often but isn’t marked a regular in OpenTable.' }) : null,
    h('div', { class: 'small muted', text: 'Everything else (phone, past visits, the floor plan) is in OpenTable.' }));
}

/** What's new on the menu, one card at a time, and a quiz on it. */
function floorNewDishes(b) {
  const dishes = b.lookup.dishes.filter((d) => d.isNew);
  const special = new Map(b.featured.filter((f) => f.kind === 'special' && f.id).map((f) => [f.id, f]));
  floorSheet('New on the menu',
    h('div', { class: 'row' }, h('h2', { class: 'sheet-title grow', text: 'New on the menu' }), h('button', { class: 'btn dark', text: 'Quiz me', onclick: () => floorQuiz(b, 'new') })),
    dishes.map((d) => h('article', { class: 'card new-card' },
      d.image ? h('img', { class: 'new-photo', src: d.image, alt: '', loading: 'lazy' }) : null,
      h('div', { class: 'kicker', text: `${d.firstSold ? `Since ${shortDate(d.firstSold)}` : 'New'}${d.price ? ` · ${usd(d.price)}` : ''}${special.has(d.id) ? ' · special' : ''}` }),
      h('h3', { text: d.name }),
      d.lines.length ? h('ul', {}, d.lines.map((l) => h('li', { text: upFirst(l) }))) : null,
      h('div', { class: 'allergy', text: `Allergy: ${d.allergyLine}` }),
      (d.swaps ?? []).filter((w) => w.allergyLine !== d.allergyLine).map((w) => h('div', { class: 'small', text: `With the ${w.label}: ${w.allergyLine}` })),
      d.wines.length ? h('div', { class: 'small', text: `Pairs with ${d.wines.join(', ')}` }) : null)),
    h('button', { class: 'btn', text: 'Quiz me on the whole menu', onclick: () => floorQuiz(b, 'all') }));
}

const qShuffle = (a) => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
const qPick = (a) => a[Math.floor(Math.random() * a.length)];
const qSame = (a, b) => a.toLowerCase() === b.toLowerCase();

/** Questions from the recipes: what's on it, which dish has these, can someone avoiding X have it, what wine. */
function quizQuestions(b, scope) {
  const all = b.lookup.dishes.filter((d) => d.kind === 'dish' && d.lines.length);
  const pool = scope === 'new' ? all.filter((d) => d.isNew) : all;
  const lines = [...new Set(all.flatMap((d) => d.lines.map(upFirst)))];
  const seenIn = new Map();
  for (const d of all) for (const l of new Set(d.lines.map((x) => x.toLowerCase()))) seenIn.set(l, (seenIn.get(l) ?? 0) + 1);
  // Every question each dish allows, then a mix: no more than three about one dish.
  const asked = [];
  for (const d of pool) {
    for (const kind of ['on', 'which', 'allergen', 'wine']) {
      if (kind === 'on') {
        // Not what's on nearly everything (Pizza Dough): what tells this dish apart.
        const telling = d.lines.filter((l) => (seenIn.get(l.toLowerCase()) ?? 0) <= Math.max(2, all.length * 0.3));
        if (!telling.length) continue;
        const right = upFirst(qPick(telling));
        const wrong = qShuffle(lines.filter((l) => !d.lines.some((x) => qSame(x, l)))).slice(0, 3);
        if (wrong.length < 3) continue;
        asked.push({ d, q: `Which of these is on the ${d.name}?`, options: qShuffle([right, ...wrong]), answer: right, why: `${d.name}: ${d.lines.map(upFirst).join(', ')}.` });
      } else if (kind === 'which') {
        const two = qShuffle(d.lines.filter((l) => (seenIn.get(l.toLowerCase()) ?? 0) <= Math.max(2, all.length * 0.3))).slice(0, 2);
        if (two.length < 2) continue;
        const has = (x) => two.every((l) => x.lines.some((y) => qSame(y, l)));
        const wrong = qShuffle(all.filter((x) => x.id !== d.id && !has(x))).slice(0, 3).map((x) => x.name);
        if (wrong.length < 3 || all.some((x) => x.id !== d.id && has(x))) continue;
        asked.push({ d, q: `Which dish has ${upFirst(two[0])} and ${two[1].toLowerCase()}?`, options: qShuffle([d.name, ...wrong]), answer: d.name, why: `${d.name}: ${d.lines.map(upFirst).join(', ')}.` });
      } else if (kind === 'allergen') {
        if (d.unchecked.length || d.unknown.length) continue;
        const keys = Object.keys(FLOOR_ALLERGENS);
        for (const key of qShuffle([...(d.contains.length ? [qPick(d.contains)] : []), qPick(keys.filter((k) => !d.contains.includes(k)))].filter(Boolean))) {
          const label = FLOOR_ALLERGENS[key].toLowerCase();
          // As it comes, or how it can be made: the crust, a modifier ("No Goat Cheese").
          const way = (d.ways ?? []).find((w) => !w.contains.includes(key) && !w.unchecked.length);
          const answer = !d.contains.includes(key) ? 'Yes' : way ? `Yes, with ${way.changes.join(' + ')}` : 'No';
          const decoy = (d.ways ?? []).find((w) => w !== way && w.contains.includes(key));
          asked.push({ d, q: `Can a guest avoiding ${label} have the ${d.name}?`, options: qShuffle(['Yes', 'No', ...(way ? [answer] : []), ...(decoy && !way ? [`Yes, with ${decoy.changes.join(' + ')}`] : [])]), answer,
            why: `${d.name}: ${d.allergyLine}.${way && answer !== 'Yes' ? ` With ${way.changes.join(' + ')}: ${way.allergyLine}.` : ''}${b.allergyNote && /gluten/.test(label) ? ` ${b.allergyNote}` : ''}` });
        }
      } else if (kind === 'wine') {
        if (!d.wines.length || b.lookup.wines.length < 3) continue;
        const right = d.wines[0];
        const wrong = qShuffle(b.lookup.wines.map((w) => w.name).filter((n) => !d.wines.includes(n))).slice(0, 3);
        if (wrong.length < 2) continue;
        const w = b.lookup.wines.find((x) => x.name === right);
        asked.push({ d, q: `Which wine would you suggest with the ${d.name}?`, options: qShuffle([right, ...wrong]), answer: right, why: w?.pairings.find((p) => p.recipeId === d.id)?.why ?? `It pairs with the ${d.name}.` });
      }
    }
  }
  const per = new Map(), out = [];
  for (const q of qShuffle(asked)) {
    if ((per.get(q.d.id) ?? 0) >= 3) continue;
    per.set(q.d.id, (per.get(q.d.id) ?? 0) + 1);
    out.push(q);
    if (out.length >= 8) break;
  }
  return out;
}

/** A quiz, ten seconds a question, nothing kept. */
function floorQuiz(b, scope) {
  const qs = quizQuestions(b, scope);
  const box = h('div', { class: 'stack quiz' });
  let n = 0, right = 0;
  const draw = () => {
    if (!qs.length) return fill(box, h('div', { class: 'muted', text: scope === 'new' ? 'Not enough on the new dishes for a quiz yet (their recipes and allergens fill it).' : 'Not enough recipes for a quiz yet.' }));
    if (n >= qs.length) return fill(box, h('h2', { text: `${right} of ${qs.length}` }), h('div', { text: right === qs.length ? 'Every one. Nice.' : right >= qs.length * 0.7 ? 'Good. Run it again to get the rest.' : 'Look over the dishes and try again.' }),
      h('div', { class: 'row' }, h('button', { class: 'btn dark', text: 'Another round', onclick: () => floorQuiz(b, scope) }), scope === 'new' ? h('button', { class: 'btn', text: 'The new dishes', onclick: () => floorNewDishes(b) }) : null));
    const q = qs[n];
    const why = h('div', { class: 'small' });
    const next = h('button', { class: 'btn dark', text: n + 1 < qs.length ? 'Next' : 'See how you did', hidden: true, onclick: () => { n++; draw(); } });
    const buttons = q.options.map((o) => h('button', { class: 'quiz-option', text: o, onclick: () => {
      if (!next.hidden) return;
      if (o === q.answer) right++;
      buttons.forEach((x) => { x.classList.toggle('right', x.textContent === q.answer); x.classList.toggle('wrong', x.textContent === o && o !== q.answer); });
      why.textContent = `${o === q.answer ? 'Right. ' : `It’s ${q.answer}. `}${q.why}`;
      next.hidden = false;
    } }));
    fill(box, h('div', { class: 'kicker', text: `${n + 1} of ${qs.length}` }), h('h2', { text: q.q }), h('div', { class: 'quiz-options' }, buttons), why, next);
  };
  draw();
  floorSheet('Quiz', h('h2', { class: 'sheet-title', text: scope === 'new' ? 'Quiz: what’s new' : 'Quiz: the menu' }), box);
}

/** A manager signed in on a POS iPad is signed out after 10 minutes untouched, back to the board. */
let floorIdleOn = false, floorIdleListening = false;
const armFloorIdle = () => { clearTimeout(floorIdle); floorIdle = setTimeout(async () => { floorIdleOn = false; await api('POST', '/api/logout'); start(); }, 10 * 60000); };
function floorIdleSignOut() {
  floorIdleOn = true;
  if (!floorIdleListening) { floorIdleListening = true; ['pointerdown', 'keydown'].forEach((e) => document.addEventListener(e, () => { if (floorIdleOn) armFloorIdle(); }, { passive: true })); }
  armFloorIdle();
}
function stopFloorIdle() { floorIdleOn = false; clearTimeout(floorIdle); }

/** A manager signs in on a POS iPad with their PIN: the board, with Manage. */
async function floorManagerSignIn() {
  const who = await floorPin({ title: 'Manager sign in', why: 'Signs out by itself after 10 minutes untouched.', managersOnly: true });
  if (!who) return;
  const r = await api('POST', '/api/login/pin', { staffId: who.staffId, pin: who.pin });
  if (!r.ok) { await floorMessage(r.data.error ?? 'That didn’t work.'); return; }
  start();
}

/** A sheet over the board: closes with its button, a tap outside, or Escape. */
function floorSheet(label, ...content) {
  document.querySelector('.sheet-wrap')?.remove();
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': label },
    h('div', { class: 'row' }, h('div', { class: 'grow' }), h('button', { class: 'btn', text: 'Close', onclick: close })), content);
  const wrap = h('div', { class: 'sheet-wrap', onclick: (e) => { if (e.target === wrap) close(); } }, panel);
  document.addEventListener('keydown', onKey);
  document.body.append(wrap);
  return { panel, close };
}

/** Search: dishes and drinks by name or what's in them, wines by name, grape or region. */
function floorLookup(b, q) {
  const k = q.toLowerCase();
  const dishes = b.lookup.dishes.filter((d) => d.name.toLowerCase().includes(k) || d.lines.some((l) => l.toLowerCase().includes(k)));
  const wines = b.lookup.wines.filter((w) => [w.name, w.producer, w.grapes, w.region].some((x) => x && x.toLowerCase().includes(k)));
  const s = floorSheet(`Look up ${q}`, h('h2', { class: 'sheet-title', text: `“${q}”` }),
    !dishes.length && !wines.length ? h('div', { class: 'muted', text: 'Nothing on the menu matches.' }) : null,
    dishes.length ? h('div', { class: 'list' }, dishes.map((d) => h('button', { class: 'pick-row', onclick: () => floorDish(b, d.id) }, h('div', { class: 'grow' }, h('div', { class: 'strong', text: d.name }), h('div', { class: 'small muted', text: d.lines.join(', ') })), h('span', { class: 'small', text: d.allergyLine })))) : null,
    wines.length ? [h('h3', { text: 'Wines' }), h('div', { class: 'list' }, wines.map((w) => h('button', { class: 'pick-row', onclick: () => floorWine(b, w.id) }, h('div', { class: 'grow' }, h('div', { class: 'strong', text: w.name }), h('div', { class: 'small muted', text: [w.region, w.grapes].filter(Boolean).join(' · ') })))))] : null);
  return s;
}

/** One dish: what's in it in the words servers say, its allergens, what wine goes with it. */
function floorDish(b, id, avoid) {
  const d = b.lookup.dishes.find((x) => x.id === id) ?? null;
  if (!d) return;
  floorSheet(d.name,
    h('div', { class: 'kicker', text: `${d.kind === 'drink' ? 'Drink' : 'Dish'}${d.price ? ` · ${usd(d.price)}` : ''}` }), h('h2', { class: 'sheet-title', text: d.name }),
    avoid?.size ? verdictBox(d, dishVerdict(d, avoid), 'They') : null,
    d.lines.length ? h('ul', { class: 'dish-lines' }, d.lines.map((l) => h('li', { text: upFirst(l) }))) : null,
    h('section', { class: 'card tight' }, h('div', { class: 'small muted strong', text: 'Allergens' }),
      h('div', { class: 'allergy-chips' }, Object.entries(FLOOR_ALLERGENS).map(([key, label]) => h('span', { class: `tag${d.contains.includes(key) ? ' bad' : ''}`, text: d.contains.includes(key) ? label : `no ${label.toLowerCase()}` }))),
      d.unchecked.length ? h('div', { class: 'warn-text small', text: `Not checked yet, so not sure: ${d.unchecked.join(', ')}. Ask the kitchen.` }) : null,
      d.unknown.length ? h('div', { class: 'warn-text small', text: `On the recipe but not matched: ${d.unknown.join(', ')}. Ask the kitchen.` }) : null,
      (d.ways ?? []).length ? h('div', { class: 'small muted strong', text: 'It can also be made' }) : null,
      (d.ways ?? []).map((w) => {
        const name = (k) => (FLOOR_ALLERGENS[k] ?? k).toLowerCase();
        const gone = d.contains.filter((k) => !w.contains.includes(k)).map((k) => `no ${name(k)}`);
        const left = w.contains.length ? `still has ${w.contains.map(name).join(', ')}` : 'none of the allergens';
        return h('div', { class: 'small' }, h('b', { text: `With ${w.changes.join(' + ')}: ` }), [...gone, left].join(' · '), w.unchecked.length ? h('span', { class: 'muted', text: ' (some ingredients not checked yet)' }) : null);
      }),
      b.allergyNote ? h('div', { class: 'small', text: b.allergyNote }) : null),
    d.wines.length ? h('section', { class: 'card tight' }, h('div', { class: 'small muted strong', text: 'Pairs with' }), d.wines.map((name) => { const w = b.lookup.wines.find((x) => x.name === name); return h('button', { class: 'linkish', text: name, onclick: () => w && floorWine(b, w.id) }); })) : null);
}

/**
 * Can this guest have it? For each dish: as it comes, or a way it can be made (a swap the kitchen offers,
 * a modifier rung on the button: "No Goat Cheese"), or not, or not sure (something in it isn't checked).
 */
function dishVerdict(d, avoid) {
  const fits = (keys) => ![...avoid].some((a) => keys.includes(a));
  const unsure = [...d.unchecked, ...d.unknown];
  if (fits(d.contains)) return unsure.length ? { kind: 'unsure', unsure } : { kind: 'yes' };
  const way = (d.ways ?? []).find((w) => fits(w.contains));
  if (way) return way.unchecked.length || d.unknown.length ? { kind: 'unsure', unsure: [...way.unchecked, ...d.unknown], way } : { kind: 'with', way };
  return { kind: 'no', has: d.contains.filter((k) => avoid.has(k)).map((k) => FLOOR_ALLERGENS[k]) };
}
const verdictBox = (d, v, who) => {
  if (v.kind === 'yes') return h('div', { class: 'verdict ok', text: `✓ ${who} can have the ${d.name}` });
  if (v.kind === 'with') return h('div', { class: 'verdict with', text: `✓ ${who} can have the ${d.name} with ${v.way.changes.join(' + ')}` });
  if (v.kind === 'unsure') return h('div', { class: 'verdict unsure', text: `? Not sure${v.way ? ` (even with ${v.way.changes.join(' + ')})` : ''}: ${v.unsure.join(', ')} not checked yet. Ask the kitchen.` });
  return h('div', { class: 'verdict no', text: `✗ ${who} can’t have the ${d.name} (${v.has.join(', ')})` });
};

/** What a guest can't have (the short list, first) or can, by what they avoid; searchable. */
function floorAllergyFinder(b) {
  const avoid = new Set();
  let showing = 'cant';
  const out = h('div', { class: 'list' });
  const search = h('input', { type: 'search', placeholder: 'Find a dish in this list…', 'aria-label': 'Find a dish' });
  const tabs = h('div', { class: 'seg', role: 'tablist' });
  const note = h('div');
  const draw = () => {
    fill(tabs, [['cant', 'Can’t have'], ['can', 'Can have']].map(([k, label]) => h('button', { class: showing === k ? 'on' : '', role: 'tab', 'aria-selected': String(showing === k), text: label, onclick: () => { showing = k; draw(); } })));
    fill(note, b.allergyNote && avoid.has('wheat') ? h('div', { class: 'note small', text: b.allergyNote }) : null);
    if (!avoid.size) return fill(out, h('div', { class: 'muted small', text: 'Tap what the guest can’t have.' }));
    const who = 'They';
    const q = search.value.trim().toLowerCase();
    const all = b.lookup.dishes.map((d) => ({ d, v: dishVerdict(d, avoid) }));
    const list = all.filter(({ v }) => (showing === 'cant' ? v.kind === 'no' || v.kind === 'unsure' : v.kind === 'yes' || v.kind === 'with'))
      .filter(({ d }) => !q || d.name.toLowerCase().includes(q) || d.lines.some((l) => l.toLowerCase().includes(q)))
      .sort((x, y) => ({ no: 0, unsure: 1, with: 1, yes: 2 })[x.v.kind] - ({ no: 0, unsure: 1, with: 1, yes: 2 })[y.v.kind] || x.d.name.localeCompare(y.d.name));
    const other = all.length - all.filter(({ v }) => (showing === 'cant' ? v.kind === 'no' || v.kind === 'unsure' : v.kind === 'yes' || v.kind === 'with')).length;
    fill(out,
      h('div', { class: 'small muted', text: `${list.length} dish${list.length === 1 ? '' : 'es'}${q ? ` matching “${search.value.trim()}”` : ''} · ${other} on the other list` }),
      list.length ? list.map(({ d, v }) => h('button', { class: 'pick-row verdict-row', onclick: () => floorDish(b, d.id, avoid) }, h('div', { class: 'grow' }, h('div', { class: 'strong', text: d.name }), verdictBox(d, v, who))))
        : h('div', { class: 'muted', text: q ? 'Not on this list. Try the other one.' : showing === 'cant' ? 'Nothing on the menu is off limits for them.' : 'Nothing on the menu fits. Ask the kitchen.' }));
  };
  search.addEventListener('input', draw);
  const chips = h('div', { class: 'allergy-chips' }, Object.entries(FLOOR_ALLERGENS).map(([key, label]) => {
    const chip = h('button', { class: 'chip', 'aria-pressed': 'false', text: `No ${label.toLowerCase()}`, onclick: () => { avoid.has(key) ? avoid.delete(key) : avoid.add(key); chip.classList.toggle('on', avoid.has(key)); chip.setAttribute('aria-pressed', String(avoid.has(key))); draw(); } });
    return chip;
  }));
  draw();
  floorSheet('Allergies', h('h2', { class: 'sheet-title', text: 'What can’t they have?' }), chips, tabs, search, note, out);
}

// Italy, roughly, for the wine map: the coast as longitude/latitude, and each region's middle.
const ITALY_SHAPES = [
  [[7.53, 43.79], [8.93, 44.41], [9.83, 44.1], [10.31, 43.55], [10.53, 42.93], [11.21, 42.44], [11.8, 42.09], [12.29, 41.73], [12.63, 41.45], [13.57, 41.21], [14.25, 40.84], [14.4, 40.62], [14.76, 40.67], [15.28, 40.03], [15.63, 40.07], [16.03, 39.36], [16.16, 38.73], [15.83, 38.62], [15.65, 38.11], [15.75, 37.93], [16.06, 37.92], [16.55, 38.69], [17.13, 39.08], [17.2, 39.03], [16.48, 39.75], [17.24, 40.47], [17.99, 40.06], [18.36, 39.8], [18.49, 40.15], [17.94, 40.64], [16.87, 41.13], [16.29, 41.32], [15.92, 41.63], [16.18, 41.88], [15.88, 41.93], [14.99, 42.0], [14.21, 42.46], [13.52, 43.62], [12.57, 44.06], [12.28, 44.42], [12.5, 44.95], [12.34, 45.44], [13.77, 45.65], [13.62, 45.94], [13.58, 46.5], [12.4, 46.7], [11.5, 47.0], [10.45, 46.62], [9.33, 46.5], [9.03, 45.84], [8.03, 46.25], [7.86, 45.92], [6.86, 45.83], [6.88, 45.68], [6.9, 45.25], [7.0, 44.67], [7.57, 44.15]],
  [[15.55, 38.19], [15.24, 38.22], [14.75, 38.16], [14.02, 38.04], [13.36, 38.12], [12.73, 38.18], [12.51, 38.02], [12.44, 37.8], [12.59, 37.65], [13.08, 37.51], [13.58, 37.29], [14.25, 37.06], [14.85, 36.73], [15.13, 36.69], [15.29, 37.07], [15.09, 37.5], [15.29, 37.85]],
  [[9.19, 41.24], [9.5, 40.92], [9.7, 40.38], [9.7, 39.93], [9.52, 39.14], [9.11, 39.21], [9.0, 38.97], [8.4, 39.06], [8.59, 39.9], [8.5, 40.3], [8.32, 40.56], [8.22, 40.94], [8.71, 40.91]],
];
const ITALY_REGIONS = {
  "Valle d'Aosta": [7.4, 45.75], Piemonte: [7.9, 45.1], Lombardia: [9.8, 45.6], 'Trentino-Alto Adige': [11.3, 46.45], Veneto: [12.0, 45.6], 'Friuli-Venezia Giulia': [13.1, 46.1], Liguria: [8.7, 44.3],
  'Emilia-Romagna': [11.0, 44.5], Toscana: [11.1, 43.4], Umbria: [12.5, 42.95], Marche: [13.1, 43.3], Lazio: [12.7, 41.9], Abruzzo: [13.9, 42.2], Molise: [14.6, 41.6], Campania: [14.8, 40.9],
  Puglia: [16.6, 41.0], Basilicata: [16.0, 40.5], Calabria: [16.4, 39.0], Sicilia: [14.1, 37.6], Sardegna: [9.0, 40.1],
};
const REGION_ALIASES = { tuscany: 'Toscana', piedmont: 'Piemonte', lombardy: 'Lombardia', sicily: 'Sicilia', sardinia: 'Sardegna', apulia: 'Puglia', friuli: 'Friuli-Venezia Giulia', 'alto adige': 'Trentino-Alto Adige', trentino: 'Trentino-Alto Adige', 'südtirol': 'Trentino-Alto Adige', aosta: "Valle d'Aosta", abruzzi: 'Abruzzo', 'emilia romagna': 'Emilia-Romagna' };
const regionOf = (name) => {
  if (!name) return undefined;
  const k = name.toLowerCase().trim();
  return Object.keys(ITALY_REGIONS).find((r) => r.toLowerCase() === k) ?? Object.entries(REGION_ALIASES).find(([a]) => k.includes(a))?.[1] ?? Object.keys(ITALY_REGIONS).find((r) => k.includes(r.toLowerCase().split('-')[0]));
};
const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, ...kids) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v); kids.flat().forEach((c) => c && el.append(c)); return el; };
const italyXY = ([lon, lat]) => [(lon - 6.5) * 7.43, (47.2 - lat) * 10];

/** The map: Italy, with a dot on each region we pour from; tap one for its wines. */
function italyMap(wines, onPick, highlight) {
  const byRegion = new Map();
  for (const w of wines) { const r = regionOf(w.region); if (r) byRegion.set(r, [...(byRegion.get(r) ?? []), w]); }
  const svg = sv('svg', { viewBox: '-4 -4 98 114', class: 'italy-map', role: 'img', 'aria-label': `Map of Italy: wines from ${[...byRegion.keys()].join(', ') || 'no region yet'}` },
    ITALY_SHAPES.map((shape) => sv('polygon', { points: shape.map(italyXY).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '), fill: '#EFEDE8', stroke: '#9A968C', 'stroke-width': '0.6', 'stroke-linejoin': 'round' })),
    [...byRegion].map(([region, list]) => {
      const [x, y] = italyXY(ITALY_REGIONS[region]);
      const on = highlight && regionOf(highlight) === region;
      const g = sv('g', { class: 'map-dot', tabindex: '0', role: 'button', 'aria-label': `${region}: ${list.length} wine${list.length === 1 ? '' : 's'}` },
        sv('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: on ? '4.2' : String(2.4 + Math.min(list.length, 4) * 0.5), fill: on ? '#B3261E' : '#1C1F22' }),
        sv('text', { x: (x + 5).toFixed(1), y: (y + 1.6).toFixed(1), 'font-size': '4.2', fill: '#1C1F22' }, document.createTextNode(region)));
      if (onPick) { g.addEventListener('click', () => onPick(region, list)); g.addEventListener('keydown', (e) => { if (e.key === 'Enter') onPick(region, list); }); }
      return g;
    }));
  return svg;
}

/** Every wine we pour, on the map and as a list. */
function floorWines(b) {
  const out = h('div', { class: 'list' });
  const draw = (region) => fill(out, (region ? b.lookup.wines.filter((w) => regionOf(w.region) === region) : b.lookup.wines).map((w) => h('button', { class: 'pick-row', onclick: () => floorWine(b, w.id) },
    h('div', { class: 'grow' }, h('div', { class: 'strong' }, w.name, w.isNew ? h('span', { class: 'tag blue', text: 'new' }) : null), h('div', { class: 'small muted', text: [w.style, w.grapes, w.region].filter(Boolean).join(' · ') })),
    h('span', { class: 'small', text: w.prices.map((p) => `${p.label} ${usd(p.price)}`).join(' · ') }))));
  draw();
  floorSheet('Wines', h('h2', { class: 'sheet-title', text: 'Our wines' }), italyMap(b.lookup.wines, (region) => draw(region)), h('button', { class: 'link small', text: 'Show every region', onclick: () => draw() }), out);
}

/** One wine: what to say at the table. */
function floorWine(b, id) {
  const w = b.lookup.wines.find((x) => x.id === id);
  if (!w) return;
  floorSheet(w.name,
    h('div', { class: 'kicker', text: [w.style, w.region, w.place].filter(Boolean).join(' · ') }), h('h2', { class: 'sheet-title', text: w.name }),
    w.prices.length ? h('div', { class: 'strong', text: w.prices.map((p) => `${p.label} ${usd(p.price)}`).join(' · ') }) : null,
    h('div', { class: 'wine-top' }, w.hasPhoto ? h('img', { class: 'wine-photo', src: `/api/floor/wines/${w.id}/photo`, alt: w.name }) : null, italyMap([w], null, w.region)),
    w.tastingNotes ? h('section', { class: 'card tight' }, h('div', { class: 'small muted strong', text: 'Tasting notes' }), h('div', { text: w.tastingNotes })) : null,
    h('div', { class: 'wine-facts' }, [['Grapes', w.grapes], ['Made in', w.vessel], ['Producer', w.producer]].filter(([, v]) => v).map(([k, v]) => h('div', {}, h('div', { class: 'small muted', text: k }), h('div', { text: v })))),
    w.pairings.length ? h('section', { class: 'card tight' }, h('div', { class: 'small muted strong', text: 'Pairs with' }), w.pairings.map((p) => h('div', {}, h('button', { class: 'linkish strong', text: p.name, onclick: () => floorDish(b, p.recipeId) }), h('div', { class: 'small muted', text: p.why })))) : null,
    w.ingredientPairings.length ? h('div', { class: 'small', text: `Also good with: ${w.ingredientPairings.join(', ')}` }) : null,
    w.story ? h('section', { class: 'card tight' }, h('div', { class: 'small muted strong', text: 'The story' }), h('div', { text: w.story })) : null,
    w.facts.length ? h('ul', { class: 'small' }, w.facts.map((f) => h('li', { text: f }))) : null);
}

/** The cut-out cards, ready to print: specials, new items, the gelato flight. */
function floorPrintCards(featured, gelato) {
  const sheet = h('div', { class: 'print-cards' },
    featured.map((f) => h('article', { class: 'print-card' }, h('div', { class: 'kicker', text: `${f.kind === 'special' ? 'Special' : 'New'}${f.price ? ` · ${usd(f.price)}` : ''}` }), h('h3', { text: f.name }), h('ul', {}, f.lines.map((l) => h('li', { text: upFirst(l) }))), f.allergyLine ? h('div', { class: 'allergy', text: `ALLERGY: ${f.allergyLine}${f.unchecked?.length && !/^Not checked/.test(f.allergyLine) ? ' (not every ingredient checked yet)' : ''}` }) : null)),
    gelato ? h('article', { class: 'print-card' }, h('div', { class: 'kicker', text: `Gelato flight ${new Date(gelato.setAt).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}` }), h('ul', {}, gelato.flavors.map((f) => h('li', { text: `${f.name}${f.vegan ? ' (v)' : ''}` })))) : null);
  document.body.append(sheet);
  document.body.classList.add('printing-cards');
  const done = () => { sheet.remove(); document.body.classList.remove('printing-cards'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 60000);
}

// ------------------------------------------------------------------ the Floor, for managers

let floorTab = 'tonight';
async function floorManage(me) {
  stopFloorTimers();
  if (me.device?.floorPostId) floorIdleSignOut(); else stopFloorIdle();
  loadingScreen(me, 'floor', 'Service');
  const r = await api('GET', '/api/floor/setup');
  if (!r.ok) return show(shell(me, 'floor', [h('header', {}, h('h1', { text: 'Service' })), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const d = r.data;
  const reload = () => refreshInPlace(() => floorManage(me));
  const tabs = h('div', { class: 'seg', role: 'tablist' }, [['tonight', 'Tonight'], ['setup', 'Setup'], ['allergens', 'Allergens & names'], ['wine', 'Wine']].map(([k, label]) =>
    h('button', { class: floorTab === k ? 'on' : '', role: 'tab', 'aria-selected': String(floorTab === k), text: label, onclick: () => { floorTab = k; floorManage(me); } })));
  const onDevice = Boolean(me.device?.floorPostId);
  const header = h('header', { class: 'row wrap' }, h('div', { class: 'grow' }, h('div', { class: 'kicker', text: 'Front of house' }), h('h1', { text: 'Service' })), tabs,
    h('button', { class: 'btn', text: onDevice ? '← The board' : 'Open a board', onclick: () => floorBoard({ me }) }));
  let content;
  if (floorTab === 'setup') content = floorSetupTab(d, reload);
  else if (floorTab === 'allergens') content = await floorAllergensTab(reload);
  else if (floorTab === 'wine') content = await floorWineTab(reload);
  else content = floorTonightTab(d, reload);
  show(shell(me, 'floor', [header, content]));
}

function floorTonightTab(d, reload) {
  const err = h('div', { class: 'error' });
  // OpenTable report.
  const file = h('input', { type: 'file', accept: '.csv,.pdf,image/*', 'aria-label': 'OpenTable report' });
  const status = h('div', { class: 'small' });
  const showReport = (rep) => fill(status, !rep ? h('span', { class: 'muted', text: 'Nothing uploaded tonight yet.' })
    : rep.status === 'reading' ? h('span', {}, h('span', { class: 'spinner' }), ' Reading it… (about a minute)')
    : rep.status === 'failed' ? h('span', { class: 'error', text: `Couldn’t read it: ${rep.error ?? ''}` })
    : h('span', { class: 'good-text', text: `✓ ${rep.source === 'csv' ? 'Export' : 'Digest'} loaded ${when(rep.at)}${rep.reservations !== undefined ? `: ${rep.reservations} reservations, ${rep.covers} covers` : ''}` }));
  showReport(d.report);
  const poll = async (id, n = 0) => { const p = await api('GET', `/api/floor/reports/${id}`); if (p.ok && p.data.status === 'reading' && n < 60) return setTimeout(() => poll(id, n + 1), 2000); showReport({ ...p.data, source: 'digest', at: new Date().toISOString() }); };
  const upload = h('button', { class: 'btn dark', text: 'Upload', onclick: () => pageAction(async () => {
    const f = file.files?.[0];
    if (!f) return (err.textContent = 'Choose the file first.');
    err.textContent = '';
    const isCsv = /\.csv$/i.test(f.name) || f.type === 'text/csv';
    const res = isCsv ? await api('POST', '/api/floor/reports', { csv: await f.text() }) : await api('POST', '/api/floor/reports', { mediaType: f.type || 'application/pdf', data: await fileToBase64(f) });
    if (!res.ok) return (err.textContent = res.data.error ?? 'Couldn’t upload.');
    file.value = '';
    if (res.data.status === 'read') showReport({ ...res.data, source: 'csv', at: new Date().toISOString() }); else { showReport({ status: 'reading' }); poll(res.data.id); }
  }) });
  const report = sideBox('Tonight’s book', h('div', { class: 'small muted', text: 'The OpenTable pre-shift digest (printed to PDF) or the reservations CSV export. Upload a newer one any time: it updates tables and new bookings, and keeps what the digest knew about guests.' }),
    file, upload, status, d.canRead ? null : h('div', { class: 'small warn-text', text: 'Reading PDFs needs ANTHROPIC_API_KEY in Render. The CSV works without it.' }));

  // Notes.
  const noteText = h('textarea', { rows: 2, placeholder: 'e.g. Half-price wine tonight. 8-top on the patio at 8:30 is the owner’s family.', 'aria-label': 'Note' });
  const noteFor = h('select', { 'aria-label': 'For' }, h('option', { value: '', text: 'Everyone' }), d.posts.map((p) => h('option', { value: p.id, text: p.name })));
  const noteWhen = h('select', { 'aria-label': 'When' }, h('option', { value: 'tonight', text: 'Tonight' }), h('option', { value: 'week', text: 'Every night this week' }), WEEKDAY_NAMES.map((n, i) => h('option', { value: `w${i}`, text: `Every ${n}` })));
  const addNote = () => pageAction(async () => {
    if (!noteText.value.trim()) return;
    const v = noteWhen.value;
    const res = await api('POST', '/api/floor/notes', { body: noteText.value, postId: noteFor.value || null, startsOn: d.today, endsOn: v === 'tonight' ? d.today : v === 'week' ? addDaysISO(d.today, 6) : '2099-12-31', ...(v.startsWith('w') ? { weekdays: [Number(v.slice(1))] } : {}) });
    if (!res.ok) return (err.textContent = res.data.error);
    reload();
  });
  const postName = (id) => d.posts.find((p) => p.id === id)?.name ?? 'Everyone';
  const notes = h('section', { class: 'card' }, h('h2', { text: 'Notes for the team' }),
    d.notes.length ? h('div', { class: 'list' }, d.notes.map((n) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { text: n.body }), h('div', { class: 'small muted', text: `${postName(n.postId)} · ${n.weekdays?.length ? `every ${n.weekdays.map((w) => WEEKDAY_NAMES[w]).join(', ')}` : n.startsOn === n.endsOn ? shortDate(n.startsOn) : `${shortDate(n.startsOn)} – ${n.endsOn >= '2099' ? 'on' : shortDate(n.endsOn)}`}${n.by ? ` · ${n.by}` : ''}` })),
      h('button', { class: 'link', text: 'Remove', onclick: () => pageAction(async () => { await api('POST', '/api/floor/notes', { id: n.id, remove: true }); reload(); }) })))) : h('div', { class: 'small muted', text: 'No notes for tonight.' }),
    noteText, h('div', { class: 'row wrap' }, noteFor, noteWhen, h('button', { class: 'btn', text: 'Add note', onclick: addNote })));

  // Specials and new items: find the dish, then make it tonight's special, or say whether it counts as new.
  const specials = d.features.filter((f) => f.kind === 'special');
  const pinned = d.features.filter((f) => f.kind === 'new');
  const hidden = d.features.filter((f) => f.kind === 'hidden');
  const isNew = (x) => x.firstSold && x.firstSold >= addDaysISO(d.today, -21);
  let chosen = null;
  const find = h('input', { type: 'search', placeholder: 'Find a dish to feature…', 'aria-label': 'Find a dish' });
  const results = h('div', { class: 'list compact' });
  const spPrice = h('input', { type: 'text', inputmode: 'decimal', class: 'short', placeholder: '$', 'aria-label': 'Price' });
  const spEnds = h('input', { type: 'date', 'aria-label': 'Last day', value: '' });
  const spDays = WEEKDAY_NAMES.map((n, i) => h('label', { class: 'inline small' }, h('input', { type: 'checkbox', value: String(i) }), n));
  const form = h('div', { class: 'stack special-form', hidden: true });
  const drawForm = () => {
    form.hidden = !chosen;
    if (!chosen) return;
    fill(form, h('div', { class: 'strong', text: `${chosen.name} as a special` }),
      h('div', { class: 'row wrap' }, spPrice, h('span', { class: 'small', text: 'until' }), spEnds, h('span', { class: 'small muted', text: '(blank: until you take it off)' })),
      h('div', { class: 'row wrap' }, h('span', { class: 'small muted', text: 'Only on' }), spDays),
      h('div', { class: 'row' }, h('button', { class: 'btn dark', text: 'Add special', onclick: () => pageAction(async () => {
        const days = spDays.map((l) => l.querySelector('input')).filter((c) => c.checked).map((c) => Number(c.value));
        const res = await api('POST', '/api/floor/features', { kind: 'special', recipeId: chosen.id, name: chosen.name, price: spPrice.value.replace('$', '') || null, startsOn: d.today, endsOn: spEnds.value || null, weekdays: days });
        if (!res.ok) return (err.textContent = res.data.error);
        reload();
      }) }), h('button', { class: 'link', text: 'Cancel', onclick: () => { chosen = null; drawForm(); } })));
  };
  const feature = (body) => pageAction(async () => { const res = await api('POST', '/api/floor/features', body); if (!res.ok) return (err.textContent = res.data.error); reload(); });
  const drawResults = () => {
    const q = find.value.trim().toLowerCase();
    if (!q) return fill(results);
    const hits = d.dishes.filter((x) => x.name.toLowerCase().includes(q)).slice(0, 8);
    fill(results, hits.length ? hits.map((x) => {
      const hid = hidden.find((f) => f.recipeId === x.id), pin = pinned.find((f) => f.recipeId === x.id);
      return h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { text: x.name }), h('div', { class: 'small muted', text: [x.price ? usd(x.price) : '', x.firstSold ? `first sold ${shortDate(x.firstSold)}` : 'not sold yet', isNew(x) && !hid ? 'showing as new' : ''].filter(Boolean).join(' · ') })),
        h('button', { class: 'link', text: 'Special', onclick: () => { chosen = x; drawForm(); } }),
        hid ? h('button', { class: 'link', text: 'Show as new', onclick: () => feature({ id: hid.id, remove: true }) })
          : isNew(x) ? h('button', { class: 'link', text: 'Not new', onclick: () => feature({ kind: 'hidden', recipeId: x.id, name: x.name, startsOn: d.today }) })
          : pin ? h('button', { class: 'link', text: 'Unpin', onclick: () => feature({ id: pin.id, remove: true }) })
          : h('button', { class: 'link', text: 'Show as new', title: 'On the New on the menu list for 3 weeks', onclick: () => feature({ kind: 'new', recipeId: x.id, name: x.name, startsOn: d.today, endsOn: addDaysISO(d.today, 21) }) }));
    }) : h('div', { class: 'small muted', text: 'No dish by that name. Write its recipe first (Recipes).' }));
  };
  find.addEventListener('input', drawResults);
  const featured = h('section', { class: 'card' }, h('h2', { text: 'Specials and new dishes' }),
    h('div', { class: 'small muted', text: 'Cards come from the recipe: what’s in it by the names servers say, and the allergy line. A dish counts as new for 3 weeks after it first sells.' }),
    specials.length ? h('div', { class: 'list' }, specials.map((f) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'strong', text: `${f.name}${f.price ? ` · ${usd(f.price)}` : ''}` }), h('div', { class: 'small muted', text: `Special · ${f.weekdays?.length ? f.weekdays.map((w) => WEEKDAY_NAMES[w]).join(', ') : 'every night'}${f.endsOn ? ` until ${shortDate(f.endsOn)}` : ''}` })),
      h('button', { class: 'link', text: 'Take off', onclick: () => feature({ id: f.id, remove: true }) })))) : null,
    find, results, form,
    h('button', { class: 'btn', text: 'Print cards', onclick: async () => { const b = await api('GET', '/api/floor/board'); if (b.ok) floorPrintCards(b.data.featured, b.data.gelato); } }));

  // Talk it up.
  const pushName = h('input', { type: 'text', placeholder: 'e.g. Borgo Monclavo Barbera', 'aria-label': 'What to talk up' });
  const pushWhy = h('input', { type: 'text', placeholder: 'Why (servers see this)', 'aria-label': 'Why' });
  const pushes = sideBox('Talk it up', h('div', { class: 'small muted', text: 'Your picks go first; the board adds the best earners on each side.' }),
    d.pushes.map((p) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'strong', text: p.name }), p.why ? h('div', { class: 'small muted', text: p.why }) : null), h('button', { class: 'link', text: 'Remove', onclick: () => pageAction(async () => { await api('POST', '/api/floor/pushes', { id: p.id, remove: true }); reload(); }) }))),
    pushName, pushWhy, h('button', { class: 'btn', text: 'Add', onclick: () => pageAction(async () => { if (!pushName.value.trim()) return; await api('POST', '/api/floor/pushes', { name: pushName.value, why: pushWhy.value }); reload(); }) }));

  // Gelato.
  const flavors = Array.from({ length: 6 }, (_, i) => d.gelato?.flavors?.[i] ?? { name: '', vegan: false });
  const fRows = flavors.map((f, i) => { const name = h('input', { type: 'text', value: f.name, placeholder: `Flavor ${i + 1}`, 'aria-label': `Flavor ${i + 1}` }); const vegan = h('input', { type: 'checkbox', checked: f.vegan ? true : undefined, 'aria-label': `Flavor ${i + 1} is vegan` }); return { name, vegan, el: h('div', { class: 'row tight' }, name, h('label', { class: 'inline small' }, vegan, 'v')) }; });
  const pans = (d.gelato?.pansOn === d.today ? d.gelato.panChanges : []).concat([{}, {}]).slice(0, Math.max(2, (d.gelato?.pansOn === d.today ? d.gelato.panChanges.length : 0) + 1));
  const pRows = pans.map((p) => { const size = h('input', { type: 'text', class: 'short', value: p.size ?? '', placeholder: '¾ pan', 'aria-label': 'Pan size' }); const from = h('input', { type: 'text', value: p.from ?? '', placeholder: 'Running low', 'aria-label': 'Flavor running low' }); const to = h('input', { type: 'text', value: p.to ?? '', placeholder: 'Next', 'aria-label': 'Next flavor' }); return { size, from, to, el: h('div', { class: 'row tight' }, size, from, h('span', { text: '→' }), to) }; });
  const gelato = h('section', { class: 'card' }, h('div', { class: 'row' }, h('h2', { class: 'grow', text: 'Gelato flight' }), h('span', { class: 'small muted', text: 'v = vegan' })),
    h('div', { class: 'gelato-edit' }, fRows.map((x) => x.el)), h('div', { class: 'small muted strong', text: 'Pans tonight: what replaces a flavor running low' }), h('div', { class: 'pan-edit' }, pRows.map((x) => x.el)),
    h('button', { class: 'btn', text: 'Save gelato', onclick: () => pageAction(async () => {
      const res = await api('POST', '/api/floor/gelato', { flavors: fRows.map((x) => ({ name: x.name.value, vegan: x.vegan.checked })), panChanges: pRows.map((x) => ({ size: x.size.value, from: x.from.value, to: x.to.value })) });
      if (!res.ok) return (err.textContent = res.data.error);
      reload();
    }) }), d.gelato ? h('div', { class: 'small muted', text: `Last set ${when(d.gelato.setAt)}` }) : null);

  const handoffs = d.handoffs.length ? sideBox('From the floor', d.handoffs.map((x) => h('div', { class: 'floor-note' }, h('div', { text: x.body }), h('div', { class: 'small muted', text: `${x.by ?? 'Someone'}${x.post ? ` · ${x.post}` : ''} · ${shortDate(x.day)}` })))) : null;
  return page([err, featured, gelato, notes], [report, pushes, handoffs]);
}
const addDaysISO = (day, n) => { const x = new Date(`${day}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

function floorSetupTab(d, reload) {
  const err = h('div', { class: 'error' });
  const KINDS = { room: 'Dining room', bar: 'Bar', counter: 'Counter', host: 'Host stand (every table)' };
  const postRow = (p) => {
    const name = h('input', { type: 'text', value: p?.name ?? '', placeholder: 'e.g. Patio', 'aria-label': 'Post name' });
    const kind = h('select', { 'aria-label': 'Kind' }, Object.entries(KINDS).map(([k, v]) => h('option', { value: k, text: v, selected: (p?.kind ?? 'room') === k ? true : undefined })));
    const tables = h('input', { type: 'text', value: (p?.tables ?? []).join(' '), placeholder: 'Tables: T1 T2 T3…', 'aria-label': 'Tables' });
    const station = h('select', { 'aria-label': 'Prep list' }, h('option', { value: '', text: 'No prep list' }), d.stations.map((s) => h('option', { value: s.id, text: `Prep: ${s.name}`, selected: p?.stationId === s.id ? true : undefined })));
    const showStation = () => { station.hidden = kind.value !== 'bar'; tables.hidden = kind.value === 'host'; };
    kind.addEventListener('change', showStation);
    showStation();
    return h('div', { class: 'row wrap post-row' }, name, kind, tables, station,
      h('button', { class: 'btn', text: p ? 'Save' : 'Add post', onclick: () => pageAction(async () => {
        const res = await api('POST', '/api/floor/posts', { ...(p ? { id: p.id } : {}), name: name.value, kind: kind.value, tables: tables.value, stationId: station.value || null });
        if (!res.ok) return (err.textContent = res.data.error);
        reload();
      }) }),
      p ? h('button', { class: 'link', text: 'Remove', onclick: () => pageAction(async () => { if (!confirmText(`Remove ${p.name}? Its iPad goes back to not being set.`)) return; await api('POST', '/api/floor/posts', { id: p.id, name: p.name, active: false }); reload(); }) }) : null);
  };
  const posts = h('section', { class: 'card' }, h('h2', { text: 'Posts' }),
    h('div', { class: 'small muted', text: 'Where an iPad stands. A dining room shows the reservations at its tables; the host stand shows every table; the bar can show a prep list too.' }),
    d.posts.map(postRow), postRow(null));
  const deviceRows = d.devices.map((x) => {
    const pick = h('select', { 'aria-label': `What ${x.name} is for` }, h('option', { value: '', text: 'Kitchen (prep)' }), d.posts.map((p) => h('option', { value: p.id, text: `Service: ${p.name}`, selected: x.postId === p.id ? true : undefined })));
    pick.addEventListener('change', () => pageAction(async () => { const res = await api('POST', `/api/devices/${x.id}`, { floorPostId: pick.value || null }); if (!res.ok) err.textContent = res.data.error; }));
    return h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { text: x.name }), h('div', { class: 'small muted', text: x.lastSeen ? `Last used ${when(x.lastSeen)}` : 'Not used yet' })), pick);
  });
  const ipads = sideBox('iPads', h('div', { class: 'small muted', text: 'Set up a new POS iPad from Settings on that iPad (signed in as a manager), then pick its post here or there.' }), deviceRows.length ? deviceRows : h('div', { class: 'small muted', text: 'No iPads set up yet.' }));
  const KLIST = { opening: 'Opening', closing: 'Closing', slow: 'When it’s slow (deep cleaning)' };
  const checklistBox = (kind) => {
    const items = d.checklists.filter((c) => c.kind === kind);
    const name = h('input', { type: 'text', placeholder: kind === 'slow' ? 'e.g. Wipe down the wine fridge' : 'e.g. Roll silverware', 'aria-label': 'Task' });
    const where = h('select', { 'aria-label': 'Where' }, h('option', { value: '', text: 'Every post' }), d.posts.map((p) => h('option', { value: p.id, text: p.name })));
    const every = kind === 'slow' ? h('input', { type: 'number', min: '1', class: 'short', value: '7', 'aria-label': 'Every so many days' }) : null;
    return h('section', { class: 'card' }, h('h2', { text: KLIST[kind] }),
      kind === 'slow' ? h('div', { class: 'small muted', text: 'Shown as reminders for slow moments, due again after so many days. A PIN gives the credit to whoever does it.' }) : null,
      items.length ? h('div', { class: 'list compact' }, items.map((c) => h('div', { class: 'row' }, h('span', { class: 'grow', text: c.name }), h('span', { class: 'small muted', text: `${d.posts.find((p) => p.id === c.postId)?.name ?? 'Every post'}${c.everyDays ? ` · every ${c.everyDays} days` : ''}` }),
        h('button', { class: 'link', text: 'Remove', onclick: () => pageAction(async () => { await api('POST', '/api/floor/checklists', { id: c.id, active: false }); reload(); }) })))) : null,
      h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, name), where, every ? [h('span', { class: 'small', text: 'every' }), every, h('span', { class: 'small', text: 'days' })] : null,
        h('button', { class: 'btn', text: 'Add', onclick: () => pageAction(async () => { const res = await api('POST', '/api/floor/checklists', { kind, name: name.value, postId: where.value || null, ...(every ? { everyDays: Number(every.value) } : {}) }); if (!res.ok) return (err.textContent = res.data.error); reload(); }) })));
  };
  const note = h('textarea', { rows: 3, 'aria-label': 'Allergy note', placeholder: 'e.g. Our gluten-sensitive crust starts gluten-free, but it’s made in a kitchen full of flour: we can’t promise it’s free of gluten. The guest decides.' });
  note.value = d.allergyNote ?? '';
  const allergyNote = sideBox('Shown with every allergy answer', note, h('button', { class: 'btn', text: 'Save', onclick: () => pageAction(async () => { await api('POST', '/api/floor/settings', { allergyNote: note.value }); reload(); }) }));
  const recipeSelect = (value, label) => h('select', { 'aria-label': label }, h('option', { value: '', text: 'Pick a recipe…' }), d.recipes.map((r) => h('option', { value: r.id, text: r.name, selected: r.id === value ? true : undefined })));
  const swapRows = [...d.swaps, { from: '', to: '', label: '' }].map((w) => ({ from: recipeSelect(w.from, 'Instead of'), to: recipeSelect(w.to, 'Use'), label: h('input', { type: 'text', value: w.label, placeholder: 'gluten-sensitive crust', 'aria-label': 'What servers call it' }) }));
  const swaps = sideBox('Swaps the kitchen offers',
    h('div', { class: 'small muted', text: 'So “no gluten” finds the pizzas that can be made on the gluten-sensitive crust. Instead of one prep, another.' }),
    swapRows.map((r) => h('div', { class: 'stack swap-row' }, h('span', { class: 'small', text: 'Instead of' }), r.from, h('span', { class: 'small', text: 'use' }), r.to, h('span', { class: 'small', text: 'called' }), r.label)),
    h('button', { class: 'btn', text: 'Save swaps', onclick: () => pageAction(async () => {
      const res = await api('POST', '/api/floor/settings', { swaps: swapRows.map((r) => ({ from: r.from.value, to: r.to.value, label: r.label.value })).filter((w) => w.from && w.to && w.label.trim()) });
      if (!res.ok) return (err.textContent = res.data.error);
      reload();
    }) }));
  return page([err, posts, checklistBox('opening'), checklistBox('closing'), checklistBox('slow')], [ipads, allergyNote, swaps]);
}

async function floorAllergensTab(reload) {
  const r = await api('GET', '/api/floor/ingredients');
  if (!r.ok) return h('div', { class: 'error', text: r.data.error });
  const d = r.data;
  const err = h('div', { class: 'error' });
  let filter = d.ingredients.some((i) => i.allergens === null) ? 'todo' : 'all';
  const out = h('div', { class: 'list' });
  const save = (id, patch) => pageAction(async () => { const res = await api('POST', `/api/floor/ingredients/${encodeURIComponent(id)}`, patch); if (!res.ok) err.textContent = res.data.error; });
  const row = (i) => {
    let chosen = new Set(i.allergens ?? i.suggested ?? []);
    const confirmed = i.allergens !== null;
    const status = h('span', { class: `tag${confirmed ? ' ok' : i.suggested ? ' warn' : ''}`, text: confirmed ? 'checked' : i.suggested ? 'suggested' : 'not checked' });
    const chips = Object.entries(FLOOR_ALLERGENS).map(([key, label]) => {
      const chip = h('button', { class: `chip${chosen.has(key) ? ' on' : ''}`, 'aria-pressed': String(chosen.has(key)), text: label, onclick: () => {
        chosen.has(key) ? chosen.delete(key) : chosen.add(key);
        chip.classList.toggle('on', chosen.has(key)); chip.setAttribute('aria-pressed', String(chosen.has(key)));
        save(i.id, { allergens: [...chosen] }); i.allergens = [...chosen]; status.className = 'tag ok'; status.textContent = 'checked';
      } });
      return chip;
    });
    const name = h('input', { type: 'text', value: i.guestName ?? '', placeholder: i.spoken, 'aria-label': `What servers call ${i.name}` });
    name.addEventListener('change', () => save(i.id, { guestName: name.value }));
    const onCards = h('input', { type: 'checkbox', checked: i.onCards ? true : undefined, 'aria-label': `Show ${i.name} on menu cards` });
    onCards.addEventListener('change', () => save(i.id, { onCards: onCards.checked }));
    return h('div', { class: 'ing-row' },
      h('div', { class: 'ing-head' }, h('div', { class: 'grow' }, h('div', { class: 'strong', text: i.name }), h('div', { class: 'small muted', text: `In ${i.usedIn.slice(0, 4).join(', ')}${i.usedIn.length > 4 ? ` and ${i.usedIn.length - 4} more` : ''}` })), status,
        !confirmed ? h('button', { class: 'btn small-btn', text: chosen.size ? 'Confirm' : 'None of them', onclick: () => { save(i.id, { allergens: [...chosen] }); i.allergens = [...chosen]; status.className = 'tag ok'; status.textContent = 'checked'; } }) : null),
      h('div', { class: 'allergy-chips' }, chips),
      h('div', { class: 'row tight wrap' }, h('span', { class: 'small muted', text: 'Servers say' }), name, h('label', { class: 'inline small' }, onCards, 'on menu cards')));
  };
  const draw = () => fill(out, d.ingredients.filter((i) => filter === 'all' || i.allergens === null).slice(0, 400).map(row));
  const todo = d.ingredients.filter((i) => i.allergens === null).length;
  const seg = h('div', { class: 'seg' }, [['todo', `To check (${todo})`], ['all', `All (${d.ingredients.length})`]].map(([k, label]) => h('button', { class: filter === k ? 'on' : '', text: label, onclick: (e) => { filter = k; seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === e.target)); draw(); } })));
  draw();
  const suggest = d.canSuggest && todo ? h('button', { class: 'btn dark', text: 'Suggest for the ones not checked', onclick: () => pageAction(async () => {
    err.textContent = '';
    const res = await api('POST', '/api/floor/ingredients/suggest');
    if (!res.ok) return (err.textContent = res.data.error);
    reload();
  }) }) : null;
  const preps = sideBox('Preps on menu cards', h('div', { class: 'small muted', text: 'How a prep reads on a card (Pomodoro Base for the Pomodoro Sauce).' }),
    d.preps.map((p) => { const input = h('input', { type: 'text', value: p.guestName ?? '', placeholder: p.name, 'aria-label': `Card name for ${p.name}` }); input.addEventListener('change', () => pageAction(async () => { await api('POST', `/api/floor/preps/${p.id}`, { guestName: input.value }); })); return h('label', { class: 'small' }, p.name, input); }));
  return page([h('section', { class: 'card' }, h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, h('h2', { text: 'Allergens and the names servers say' }),
    h('div', { class: 'small muted', text: 'Tag what you buy once; every dish works out its own allergens through its recipes. Suggestions come from Claude: check each before confirming, especially prepared things like salumi.' })), seg), suggest, err, out)], [preps]);
}

async function floorWineTab(reload) {
  const r = await api('GET', '/api/floor/wines');
  if (!r.ok) return h('div', { class: 'error', text: r.data.error });
  const d = r.data;
  const err = h('div', { class: 'error' });
  const file = h('input', { type: 'file', accept: '.pdf,image/*', 'aria-label': 'Tech sheets' });
  const review = h('div', { class: 'stack' });
  const showScan = async (id) => {
    const s = await api('GET', `/api/floor/wines/scan/${id}`);
    if (!s.ok) return fill(review, h('div', { class: 'error', text: s.data.error }));
    if (s.data.status === 'reading') { fill(review, h('div', { class: 'small' }, h('span', { class: 'spinner' }), ' Reading the tech sheets…')); return setTimeout(() => showScan(id), 2500); }
    if (s.data.status === 'failed') return fill(review, h('div', { class: 'error', text: `Couldn’t read them: ${s.data.error ?? ''}` }));
    const wines = s.data.wines ?? [];
    const picks = wines.map((w) => {
      const buttons = d.buttons.map((bt) => h('label', { class: 'inline small' }, h('input', { type: 'checkbox', value: bt.catalogId, checked: w.catalogIds.includes(bt.catalogId) ? true : undefined }), bt.name));
      const keep = h('input', { type: 'checkbox', checked: true, 'aria-label': `Save ${w.name}` });
      return { w, keep, buttons, el: h('div', { class: 'card tight' }, h('label', { class: 'inline strong' }, keep, w.name), h('div', { class: 'small muted', text: [w.style, w.region, w.grapes].filter(Boolean).join(' · ') }), w.tastingNotes ? h('div', { class: 'small', text: w.tastingNotes }) : null,
        h('details', {}, h('summary', { class: 'small', text: `Square buttons (${w.catalogIds.length} matched)` }), h('div', { class: 'button-picks' }, buttons))) };
    });
    fill(review, h('h3', { text: `Read ${wines.length} wine${wines.length === 1 ? '' : 's'}` }), picks.map((p) => p.el),
      h('button', { class: 'btn dark', text: 'Save these wines', onclick: () => pageAction(async () => {
        const list = picks.filter((p) => p.keep.checked).map((p) => ({ ...p.w, catalogIds: p.buttons.map((l) => l.querySelector('input')).filter((c) => c.checked).map((c) => c.value) }));
        const res = await api('POST', `/api/floor/wines/scan/${id}/save`, { wines: list });
        if (!res.ok) return (err.textContent = res.data.error);
        reload();
      }) }));
  };
  const pending = d.scans.find((s) => s.status === 'reading' || s.status === 'read');
  if (pending) showScan(pending.id);
  const upload = sideBox('Tech sheets', h('div', { class: 'small muted', text: 'A PDF of producers’ tech sheets (several in one is fine). Each wine becomes a card: tasting notes, the story, grapes, where it’s from.' }), file,
    h('button', { class: 'btn dark', text: 'Read them', onclick: () => pageAction(async () => {
      const f = file.files?.[0];
      if (!f) return (err.textContent = 'Choose the file first.');
      const res = await api('POST', '/api/floor/wines/scan', { mediaType: f.type || 'application/pdf', data: await fileToBase64(f) });
      if (!res.ok) return (err.textContent = res.data.error);
      showScan(res.data.id);
    }) }), d.canRead ? null : h('div', { class: 'small warn-text', text: 'Reading needs ANTHROPIC_API_KEY in Render.' }), review);
  const card = (w) => {
    const links = d.buttons.map((bt) => h('label', { class: 'inline small' }, h('input', { type: 'checkbox', value: bt.catalogId, checked: w.catalogIds.includes(bt.catalogId) ? true : undefined }), bt.name));
    const photo = h('input', { type: 'file', accept: 'image/*', 'aria-label': `Photo of ${w.name}` });
    photo.addEventListener('change', () => pageAction(async () => { const f = photo.files?.[0]; if (!f) return; await api('POST', `/api/floor/wines/${w.id}`, { photo: await fileToBase64(f), photoType: f.type }); reload(); }));
    return h('section', { class: 'card' },
      h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, h('h3', {}, w.name, w.isNew ? h('span', { class: 'tag blue', text: 'new' }) : null), h('div', { class: 'small muted', text: [w.style, w.region, w.grapes].filter(Boolean).join(' · ') })),
        w.stopped ? h('span', { class: 'tag warn', text: `Not sold since ${shortDate(w.lastSold)}` }) : null, w.unlinked ? h('span', { class: 'tag', text: 'No Square button' }) : null),
      w.stopped ? h('div', { class: 'note small' }, 'Off the list? ', h('button', { class: 'link', text: 'Remove its card', onclick: () => pageAction(async () => { await api('POST', `/api/floor/wines/${w.id}`, { active: false }); reload(); }) })) : null,
      w.tastingNotes ? h('div', { class: 'small', text: w.tastingNotes }) : null,
      h('div', { class: 'small strong', text: 'Pairs with' }),
      w.pairings.length ? h('div', { class: 'small', text: w.pairings.map((p) => `${p.name} (${p.why})`).join(' · ') }) : h('div', { class: 'small muted', text: w.sheetPairings.length ? `The sheet says: ${w.sheetPairings.join(', ')}` : 'None yet.' }),
      w.suggested ? h('div', { class: 'card tight suggest' }, h('div', { class: 'small strong', text: 'Claude suggests' }), w.suggested.map((p) => h('div', { class: 'small' }, h('b', { text: p.name }), ` · ${p.why}`)),
        h('div', { class: 'row' }, h('button', { class: 'btn small-btn dark', text: 'Use these', onclick: () => pageAction(async () => { await api('POST', `/api/floor/wines/${w.id}/pairings`, { pairings: w.suggested }); reload(); }) }),
          h('button', { class: 'btn small-btn', text: 'No thanks', onclick: () => pageAction(async () => { await api('POST', `/api/floor/wines/${w.id}/pairings`, { pairings: w.pairings }); reload(); }) })))
        : d.canRead ? h('button', { class: 'btn small-btn', text: w.pairings.length ? 'Suggest again' : 'Suggest pairings', onclick: () => pageAction(async () => { const res = await api('POST', `/api/floor/wines/${w.id}/suggest`); if (!res.ok) return (err.textContent = res.data.error); reload(); }) }) : null,
      h('details', {}, h('summary', { class: 'small', text: `Square buttons (${w.catalogIds.length})` }), h('div', { class: 'button-picks' }, links),
        h('button', { class: 'btn small-btn', text: 'Save buttons', onclick: () => pageAction(async () => { await api('POST', `/api/floor/wines/${w.id}`, { catalogIds: links.map((l) => l.querySelector('input')).filter((c) => c.checked).map((c) => c.value) }); reload(); }) })),
      h('label', { class: 'small' }, w.hasPhoto ? 'Replace the bottle photo' : 'Add a bottle photo', photo));
  };
  const missing = d.notCarded.length ? sideBox('Sold lately, no card yet', h('div', { class: 'small muted', text: 'Upload their tech sheets to make cards.' }), h('ul', { class: 'small plain-list' }, d.notCarded.map((b) => h('li', { text: b.name })))) : null;
  return page([err, d.wines.length ? h('section', { class: 'card' }, h('h2', { text: 'Where they’re from' }), italyMap(d.wines)) : null, d.wines.map(card), !d.wines.length ? h('div', { class: 'card muted', text: 'No wine cards yet. Upload the tech sheets on the right.' }) : null], [upload, missing]);
}

// ================================================================== Inventory
// Three lists (Kitchen, Alcohol, Other), each in sections by where things are kept, counted the way
// things are stored ("2 bags + 5 lb") and worth what it's worth at today's prices.

const COUNTERS = { kitchen: 'The chef', bar: 'The bar manager', foh: 'The FOH manager' };
async function inventoryHome(me) {
  loadingScreen(me, 'inventory', 'Inventory');
  const r = await api('GET', '/api/inventory');
  if (!r.ok) return show(shell(me, 'inventory', [h('header', {}, h('h1', { text: 'Inventory' })), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const d = r.data;
  const reload = () => refreshInPlace(() => inventoryHome(me));
  const err = h('div', { class: 'error' });
  // Setting up: three lists, each with its sections in the order they're walked (one per line:
  // "Walk-in · top shelf: vegetables", what's after the colon helps put things where they belong).
  const START = {
    Kitchen: ['kitchen', 'Walk-in · top shelf: vegetables\nWalk-in · second shelf: dairy, prepped items\nWalk-in · bottom shelf: meats\nWalk-in · floor: dough\nWalk-in freezer: gelato, frozen purees, frozen ground pork, ground beef, pork sausage, frozen prep, meatballs, lamb sausage\nDry storage · bottom shelf: flour, sugar, dextrose, tomato cans\nDry storage · second shelf: bulk bins, dextrose, nonfat milk, sugar, maltodextrin\nDry storage · third shelf: basil, cherry tomatoes, shallots\nKitchen shelf: oils, apricot puree, vinegars, spices'],
    Alcohol: ['bar', 'Cabinets above the bar: liquor\nServer station fridge (interior dining room): wine\nCabinets above the server station\nBooth benches\nWalk-in · kegs: keg, beer'],
    Other: ['foh', 'Dry storage · top shelf: pizza boxes\nCleaning supplies: cleaning\nDisposables: box, cups, lids, napkins'],
  };
  const boxes = Object.entries(START).map(([name, [countedBy, text]]) => { const t = h('textarea', { rows: String(text.split('\n').length + 1), 'aria-label': `${name} sections` }); t.value = text; return { name, countedBy, t }; });
  const setUp = h('section', { class: 'card' }, h('h2', { text: 'Set up the lists' }),
    h('div', { class: 'small muted', text: 'Three lists: Kitchen (the chef counts it), Alcohol (the bar manager) and Other: cleaning supplies and disposables (the FOH manager). Each is in sections, one per line, in the order you walk them; after the colon, what’s usually there, so ingredients start in the right place. Change anything here or later.' }),
    boxes.map((x) => h('label', { class: 'stack' }, h('span', { class: 'strong', text: `${x.name} · ${COUNTERS[x.countedBy]} counts it` }), x.t)),
    h('button', { class: 'btn dark', text: 'Make the lists and place everything', onclick: (e) => pageAction(async () => {
      busy(e.currentTarget, true);
      for (const x of boxes) {
        const res = await api('POST', '/api/inventory/lists', { name: x.name, countedBy: x.countedBy });
        if (!res.ok) { busy(e.currentTarget, false); return (err.textContent = res.data.error ?? 'That didn’t work.'); }
        for (const line of x.t.value.split('\n').map((l) => l.trim()).filter(Boolean)) {
          const [name, holds] = line.split(/:(.*)/s).map((v) => (v ?? '').trim());
          await api('POST', '/api/inventory/sections', { listId: res.data.id, name, holds });
        }
      }
      await api('POST', '/api/inventory/place-all');
      reload();
    }) }));
  const total = d.lists.reduce((a, l) => a + (l.last?.value ?? 0), 0);
  const cards = d.lists.map((l) => h('section', { class: 'card inv-list' },
    h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, h('h2', { text: l.name }), h('div', { class: 'small muted', text: `${COUNTERS[l.countedBy]} counts it · ${l.sections.reduce((a, s) => a + s.items, 0)} items in ${l.sections.length} section${l.sections.length === 1 ? '' : 's'}` })),
      l.last ? h('div', { class: 'inv-last' }, h('div', { class: 'big', text: dollars(l.last.value) }), h('div', { class: 'small muted', text: `${l.last.finished ? 'Counted' : 'Being counted'} ${shortDate(l.last.day)}${l.last.unpriced ? ` · ${l.last.unpriced} without a price` : ''}` })) : h('div', { class: 'small muted', text: 'Not counted yet' })),
    h('div', { class: 'row wrap' }, h('button', { class: 'btn dark', text: l.last && !l.last.finished && l.last.day === d.today ? 'Keep counting' : 'Count', onclick: () => inventoryList(me, l.id, 'count') }),
      h('button', { class: 'btn', text: 'Arrange', onclick: () => inventoryList(me, l.id, 'arrange') }))));
  const loose = d.notOnAList ? h('div', { class: 'note' }, `${d.notOnAList} ingredient${d.notOnAList === 1 ? ' isn’t' : 's aren’t'} on a list yet (bought lately or in a recipe). `,
    h('button', { class: 'link', text: 'Put them on their likeliest lists', onclick: () => pageAction(async () => { const res = await api('POST', '/api/inventory/place-all'); if (!res.ok) return (err.textContent = res.data.error); reload(); }) })) : null;
  const addList = atLeast(me.roleLevel, 'manager') && d.lists.length ? (() => {
    const name = h('input', { type: 'text', placeholder: 'e.g. Bar fridges', 'aria-label': 'New list' });
    const by = h('select', { 'aria-label': 'Who counts it' }, Object.entries(COUNTERS).map(([k, v]) => h('option', { value: k, text: v })));
    return sideBox('Another list', name, by, h('button', { class: 'btn', text: 'Add list', onclick: () => pageAction(async () => { if (!name.value.trim()) return; await api('POST', '/api/inventory/lists', { name: name.value, countedBy: by.value }); reload(); }) }));
  })() : null;
  show(shell(me, 'inventory', [
    h('header', { class: 'row wrap' }, h('div', { class: 'grow' }, h('div', { class: 'kicker', text: 'Counted Saturday afternoons' }), h('h1', { text: 'Inventory' }))),
    page([err, loose, d.lists.length ? cards : setUp], [d.lists.length ? statBox('On hand', dollars(total), h('div', { class: 'small muted', text: 'At today’s prices, from each list’s last count.' })) : null, addList]),
  ]));
}

/** A list, to count (amounts as things are stored) or to arrange (sections, order, which list). */
async function inventoryList(me, listId, mode = 'count') {
  loadingScreen(me, 'inventory', 'Inventory');
  const r = await api('GET', `/api/inventory/lists/${listId}`);
  if (!r.ok) return show(shell(me, 'inventory', [h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const d = r.data;
  const reload = () => refreshInPlace(() => inventoryList(me, listId, mode));
  let countId = d.count?.id ?? null;
  const items = d.sections.flatMap((s) => s.items);
  const totalEl = h('div', { class: 'big' });
  const countedEl = h('div', { class: 'small muted' });
  const drawTotal = () => {
    const done = items.filter((i) => i.counted);
    totalEl.textContent = dollars(done.reduce((a, i) => a + (i.counted.value ?? 0), 0));
    countedEl.textContent = `${done.length} of ${items.length} counted${done.some((i) => i.counted.value === undefined) ? ` · ${done.filter((i) => i.counted.value === undefined).length} without a value` : ''}`;
  };
  const unitLabel = (i, u) => (i.sizes?.[u] ? `${u} (${nice(i.sizes[u])} ${UNIT_LABEL(i.base)})` : UNIT_LABEL(u));
  const save = async (i, parts, out) => {
    if (!countId) { const c = await api('POST', `/api/inventory/lists/${listId}/count`); if (!c.ok) return (out.textContent = c.data.error); countId = c.data.id; }
    const res = await api('POST', `/api/inventory/counts/${countId}/line`, { kind: i.kind, itemId: i.id, parts });
    if (!res.ok) { out.className = 'small error'; out.textContent = res.data.error ?? 'Not saved.'; return; }
    i.counted = parts.length ? { parts, ...(res.data.amount !== undefined ? { amount: res.data.amount } : {}), ...(res.data.value !== undefined ? { value: res.data.value } : {}) } : undefined;
    out.className = `small inv-worth${res.data.problem ? ' warn-text' : ''}`;
    out.textContent = !parts.length ? '' : res.data.problem ? res.data.problem : `${nice(res.data.amount)} ${UNIT_LABEL(res.data.base)}${res.data.value !== undefined ? ` · ${money2(res.data.value)}` : ' · no price yet'}`;
    drawTotal();
  };
  const countRow = (i) => {
    let parts = i.counted?.parts?.length ? i.counted.parts.map((p) => ({ ...p })) : [{ amount: '', unit: i.units[0] }];
    const out = h('div', { class: 'small inv-worth', text: i.counted ? (i.counted.amount !== undefined ? `${nice(i.counted.amount)} ${UNIT_LABEL(i.base)}${i.counted.value !== undefined ? ` · ${money2(i.counted.value)}` : ' · no price yet'}` : 'Can’t tell how much that is') : '' });
    const partsBox = h('div', { class: 'inv-parts' });
    let timer;
    const changed = () => { clearTimeout(timer); timer = setTimeout(() => save(i, parts.filter((p) => p.amount !== '' && Number(p.amount) >= 0).map((p) => ({ amount: Number(p.amount), unit: p.unit })), out), 400); };
    const draw = () => fill(partsBox, parts.map((p, n) => {
      const amt = h('input', { inputmode: 'decimal', class: 'short', value: p.amount === '' ? '' : String(p.amount), placeholder: '0', 'aria-label': `How many (${i.name})` });
      amt.addEventListener('input', () => { const v = parseAmount(amt.value); p.amount = amt.value.trim() === '' ? '' : Number.isNaN(v) ? p.amount : v; changed(); });
      const unit = h('select', { 'aria-label': `Unit for ${i.name}` }, i.units.map((u) => h('option', { value: u, text: unitLabel(i, u), selected: u === p.unit ? true : undefined })));
      unit.addEventListener('change', () => { p.unit = unit.value; changed(); });
      return h('span', { class: 'inv-part' }, n ? h('span', { class: 'muted', text: '+' }) : null, amt, unit,
        n ? h('button', { class: 'btn small-btn', 'aria-label': 'Remove this part', text: '×', onclick: () => { parts.splice(n, 1); draw(); changed(); } }) : null);
    }), h('button', { class: 'btn small-btn', text: '+ unit', title: 'Count in more than one unit: 2 cases + 5 lb', onclick: () => { parts.push({ amount: '', unit: i.units.find((u) => !parts.some((p) => p.unit === u)) ?? i.units[0] }); draw(); } }));
    draw();
    return h('div', { class: 'inv-row' },
      h('div', { class: 'inv-name' }, h('div', { class: 'strong', text: i.name }), i.last ? h('div', { class: 'small muted', text: `Last: ${i.last.parts.map((p) => `${nice(p.amount)} ${p.unit}`).join(' + ')} (${shortDate(i.last.day)})` }) : null),
      partsBox, out);
  };
  // Arranging: order in the section, the section, the list; sections named for where they are.
  const moveTo = (i, sectionId) => pageAction(async () => { await api('POST', '/api/inventory/place', { kind: i.kind, itemId: i.id, sectionId }); reload(); });
  const arrangeRow = (i) => {
    const where = h('select', { 'aria-label': `Move ${i.name}` }, h('option', { value: '', text: 'Move to…' }),
      d.lists.map((l) => h('optgroup', { label: l.name }, l.sections.map((s) => h('option', { value: s.id, text: s.name })))), h('option', { value: '__off', text: 'Don’t count it' }));
    where.addEventListener('change', () => where.value && moveTo(i, where.value === '__off' ? null : where.value));
    return h('div', { class: 'inv-row arrange' }, h('div', { class: 'inv-name strong', text: i.name }),
      h('div', { class: 'row tight' }, h('button', { class: 'btn small-btn', 'aria-label': `Move ${i.name} up`, text: '↑', onclick: () => pageAction(async () => { await api('POST', '/api/inventory/move', { kind: i.kind, itemId: i.id, dir: 'up' }); reload(); }) }),
        h('button', { class: 'btn small-btn', 'aria-label': `Move ${i.name} down`, text: '↓', onclick: () => pageAction(async () => { await api('POST', '/api/inventory/move', { kind: i.kind, itemId: i.id, dir: 'down' }); reload(); }) }), where));
  };
  const addHere = (s) => {
    const q = h('input', { type: 'search', placeholder: 'Add an item here…', 'aria-label': `Add an item to ${s.name}` });
    const results = h('div', { class: 'list compact' });
    let t;
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => {
      if (q.value.trim().length < 2) return fill(results);
      const res = await api('GET', `/api/inventory/search?q=${encodeURIComponent(q.value.trim())}`);
      fill(results, (res.data.items ?? []).slice(0, 8).map((x) => h('div', {}, h('span', { class: 'grow', text: x.name }), h('span', { class: 'small muted', text: x.section ? `on ${x.list} · ${x.section}` : 'not on a list' }),
        h('button', { class: 'btn small-btn', text: x.section === s.name ? 'Here' : 'Put here', disabled: x.section === s.name ? true : undefined, onclick: () => moveTo(x, s.id) }))));
    }, 250); });
    return h('div', { class: 'inv-add' }, q, results);
  };
  const sectionHead = (s, n) => mode === 'arrange'
    ? h('div', { class: 'row wrap inv-sec-head' },
      (() => { const name = h('input', { type: 'text', value: s.name, 'aria-label': 'Section name' }); name.addEventListener('change', () => pageAction(async () => { await api('POST', '/api/inventory/sections', { id: s.id, name: name.value, holds: s.holds ?? '' }); })); return h('div', { class: 'grow' }, name); })(),
      h('button', { class: 'btn small-btn', text: '↑', 'aria-label': 'Section up', disabled: n === 0 ? true : undefined, onclick: () => pageAction(async () => { await api('POST', '/api/inventory/sections', { id: s.id, move: 'up' }); reload(); }) }),
      h('button', { class: 'btn small-btn', text: '↓', 'aria-label': 'Section down', onclick: () => pageAction(async () => { await api('POST', '/api/inventory/sections', { id: s.id, move: 'down' }); reload(); }) }),
      !s.items.length ? h('button', { class: 'link', text: 'Remove', onclick: () => pageAction(async () => { await api('POST', '/api/inventory/sections', { id: s.id, active: false }); reload(); }) }) : null)
    : h('h2', { text: s.name });
  const sectionsEl = d.sections.map((s, n) => h('section', { class: 'card inv-section' }, sectionHead(s, n),
    s.items.length ? s.items.map(mode === 'arrange' ? arrangeRow : countRow) : h('div', { class: 'small muted', text: 'Nothing here yet.' }),
    mode === 'arrange' ? addHere(s) : null));
  const newSection = mode === 'arrange' ? (() => {
    const name = h('input', { type: 'text', placeholder: 'e.g. Walk-in · top shelf', 'aria-label': 'New section' });
    return h('section', { class: 'card tight' }, h('div', { class: 'small muted strong', text: 'Another section' }), h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, name),
      h('button', { class: 'btn', text: 'Add', onclick: () => pageAction(async () => { if (!name.value.trim()) return; await api('POST', '/api/inventory/sections', { listId, name: name.value }); reload(); }) })));
  })() : null;
  drawTotal();
  const finish = h('button', { class: 'btn dark', text: d.count?.finished ? 'Counted ✓ (finish again)' : 'Finish the count', onclick: () => pageAction(async () => {
    if (!countId) return;
    const res = await api('POST', `/api/inventory/counts/${countId}/finish`);
    if (res.ok) { await floorMessage(`${d.list.name}: ${res.data.lines} items, ${dollars(res.data.value)} on hand.`); inventoryHome(me); }
  }) });
  show(shell(me, 'inventory', [
    h('header', { class: 'row wrap' }, h('div', { class: 'grow' }, h('div', { class: 'kicker', text: `${COUNTERS[d.list.countedBy]} counts it` }), h('h1', { text: d.list.name })),
      h('div', { class: 'seg' }, [['count', 'Count'], ['arrange', 'Arrange']].map(([k, label]) => h('button', { class: mode === k ? 'on' : '', text: label, onclick: () => inventoryList(me, listId, k) }))),
      h('button', { class: 'btn', text: '← Inventory', onclick: () => inventoryHome(me) })),
    page([sectionsEl, newSection], mode === 'count' ? [sideBox('Counted so far', totalEl, countedEl, h('div', { class: 'small muted', text: 'Saved as you go. Count the way it’s stored: “+ unit” for 2 cases + 5 lb.' }), finish)]
      : [sideBox('Arranging', h('div', { class: 'small muted', text: 'Order the sections the way you walk them, and items the way they sit on the shelf. “Move to…” sends an item to another section or list.' }))], { sticky: true }),
  ]));
}

start();
