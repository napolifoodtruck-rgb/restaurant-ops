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
  menu: 'M4 5.5C6.5 4.5 9.5 4.5 12 6c2.5-1.5 5.5-1.5 8-.5V19c-2.5-1-5.5-1-8 .5-2.5-1.5-5.5-1.5-8-.5z M12 6v13.5',
  margins: 'M4 20V4 M4 20h16 M8 16v-4 M12 16V8 M16 16v-6',
  orders: 'M3 7h11v9H3z M14 10h4l3 3v3h-7',
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

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = {};
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

/** Replace an element's children, skipping empty slots (null, false, nested arrays flattened). */
function fill(el, ...kids) { el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)); }
function show(...nodes) { fill(app, ...nodes); }

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

async function start() {
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
  show(h('div', { class: 'center' }, form));
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
  show(h('div', { class: 'center' }, form));
}

// ------------------------------------------------------------------ invite: set a password

async function inviteScreen(token) {
  const r = await api('GET', `/api/invites/${token}`);
  const leave = () => { history.replaceState(null, '', '/'); start(); };
  if (!r.ok) {
    return show(h('div', { class: 'center' }, h('div', { class: 'panel' },
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
  show(h('div', { class: 'center' }, form));
}

// ------------------------------------------------------------------ kitchen iPad: name, then PIN

function pinNames({ device, staff }) {
  const withPin = staff.filter((s) => s.hasPin);
  show(h('div', { class: 'center' }, h('div', { class: 'names-wrap' },
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
  show(h('div', { class: 'center' }, h('div', { class: 'panel' },
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
    ['today', 'Today', todayScreen], ['prep', 'Prep', prepHome], ['menu', 'Menu', manager && menuScreen], ['margins', 'Performance', manager && marginsScreen], ['orders', 'Orders', null],
  ];
  return h('div', { class: 'shell' },
    h('nav', { class: 'rail', 'aria-label': 'Main' },
      h('div', { class: 'logo', text: (me.restaurantName ?? 'N')[0] }),
      nav.map(([key, label, go]) => h('button', { class: active === key ? 'on' : '', disabled: !go, title: go ? label : 'Coming next', onclick: go ? () => go(me) : undefined }, icon(key), label)),
      h('div', { class: 'spacer' }),
      h('button', { class: active === 'settings' ? 'on' : '', onclick: () => home(me) }, icon('settings'), 'Settings'),
    ),
    h('main', {}, content),
  );
}

function loadingScreen(me, active, title) {
  show(shell(me, active, [h('header', {}, h('h1', { text: title })), h('p', { class: 'muted', text: 'Working it out…' })]));
}

const dollars = (v, opts = {}) => (Math.abs(v) >= 10000 && !opts.exact ? `$${(v / 1000).toFixed(1)}k` : `$${v.toLocaleString(undefined, { minimumFractionDigits: opts.cents ? 2 : 0, maximumFractionDigits: opts.cents ? 2 : 0 })}`);
const pct = (v) => (v === undefined || v === null ? '–' : `${(v * 100).toFixed(1)}%`);
const shortDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function missingNote(missing) {
  if (!missing?.length) return null;
  const words = { square: 'Square sales (press Sync now on the Square card in Settings)', marginedge: 'MarginEdge invoices (Sync now on the MarginEdge card)', recipeCards: 'recipe cards (Import the kitchen-book file in Settings)' };
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

function rangePicker(me, state, m) {
  const same = (a, b) => (!a && !b) || (a && b && a.from === b.from && a.to === b.to);
  const fromInput = h('input', { type: 'date', value: m.from, min: m.dataFrom, max: iso(new Date()), 'aria-label': 'From' });
  const toInput = h('input', { type: 'date', value: m.to, min: m.dataFrom, max: iso(new Date()), 'aria-label': 'To' });
  return h('div', { class: 'row wrap' },
    presetRanges().map(([label, r]) => h('button', { class: `btn small-btn${same(r, state.range) ? ' dark' : ''}`, text: label, onclick: () => marginsScreen(me, { ...state, range: r }) })),
    h('span', { class: 'row tight' }, fromInput, h('span', { class: 'muted', text: 'to' }), toInput,
      h('button', { class: 'btn small-btn', text: 'Show', onclick: () => fromInput.value && toInput.value && marginsScreen(me, { ...state, range: { from: fromInput.value, to: toInput.value } }) })),
  );
}

// Sortable columns: what each sorts by, and which way a first click goes.
const MARGIN_COLUMNS = [
  { key: 'name', label: 'Dish', value: (d) => d.name.toLowerCase(), first: 'asc' },
  { key: 'price', label: 'One plate: food | left over', value: (d) => d.averagePrice, first: 'desc' },
  { key: 'plate', label: 'Per plate', value: (d) => d.leftPerPlate, first: 'desc' },
  { key: 'sold', label: 'Sold', value: (d, view) => (view === 'day' ? d.soldPerDay ?? 0 : d.sold), first: 'desc', num: true },
  { key: 'left', label: (view) => (view === 'day' ? 'Left over per day on the menu' : 'Left over, all of them'), value: (d, view) => (view === 'day' ? d.leftPerDay ?? 0 : d.leftTotal), first: 'desc' },
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
  const tabs = categoryTabs(me, state, m, cat?.name, again);
  const start = m.dataFrom && m.dataFrom > m.from ? m.dataFrom : m.from;
  const days = Math.round((Date.parse(m.to) - Date.parse(start)) / 86400000) + 1;
  const early = m.dataFrom && m.from < m.dataFrom ? h('div', { class: 'note', text: `Sales are stored from ${shortDate(m.dataFrom)}, so this period starts there.` }) : null;
  const header = h('header', { class: 'row wrap' },
    h('div', { class: 'grow' },
      h('div', { class: 'kicker', text: `${cat ? cat.name + ' · ' : ''}${shortDate(m.from)} – ${shortDate(m.to)} · prices from Square, costs from MarginEdge` }),
      h('h1', { text: 'Menu Performance' }),
      h('div', { class: 'sub', text: `Food cost ${pct(m.totals.foodCostShare)} on ${sideOf(me) === 'bar' ? 'drinks' : 'dishes'} with recipe cards. ${dollars(m.totals.leftOver)} left after food in ${days} days. Costs are priced as of ${shortDate(m.to)}.` })),
    tabs);
  const picker = rangePicker(me, { ...state, category: cat?.name }, m);
  if (!cat) return show(shell(me, 'margins', [header, picker, missingNote(m.missing), h('p', { class: 'muted', text: 'No dishes with recipe cards sold in this period.' })]));

  const perDay = state.view === 'day';
  const column = MARGIN_COLUMNS.find((c) => c.key === state.sort.key) ?? MARGIN_COLUMNS[4];
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
  const bar = (cls, width) => { const b = h('div', { class: cls }); b.style.width = `${Math.max(0, width)}px`; return b; };
  const partOfPeriod = (d) => d.daysOn && d.daysOn < m.openDays;
  const rows = dishes.map((d) => {
    const plate = h('div', { class: 'pricebar' }, bar('food', (d.plateCost / maxPrice) * 180), bar('left', ((d.averagePrice - d.plateCost) / maxPrice) * 180));
    const [roleText, roleCls] = ROLE[d.role] ?? ['', ''];
    const value = perDay ? d.leftPerDay ?? 0 : d.leftTotal;
    const other = perDay ? `${dollars(d.leftTotal)} in all` : d.leftPerDay !== undefined ? `${dollars(d.leftPerDay)} a day` : '';
    const note = d.offSince ? `off the menu since ${shortDate(d.offSince)}` : partOfPeriod(d) ? `on the menu ${d.daysOn} of ${m.openDays} days, since ${shortDate(d.firstSold)}` : null;
    const opened = state.open?.includes(d.name);
    const row = h('div', { class: `mrow${d.offSince ? ' off' : ''}` },
      h('div', {}, h('button', { class: 'name linkish', 'aria-expanded': opened ? 'true' : 'false', title: 'Show the plate, ingredient by ingredient', onclick: () => again({ open: opened ? state.open.filter((n) => n !== d.name) : [...(state.open ?? []), d.name] }) }, d.name, h('span', { class: 'muted', text: opened ? ' ▾' : ' ▸' })), note ? h('div', { class: 'small muted', text: note }) : null),
      h('div', { class: 'row tight' }, plate, h('span', { class: 'small muted', text: `${dollars(d.averagePrice, { cents: true })}` })),
      h('div', { class: 'small', text: `${dollars(d.plateCost, { cents: true })}${d.estimated ? '*' : ''} food · ${dollars(d.leftPerPlate, { cents: true })} left` }),
      h('div', { class: 'num' }, h('div', { text: d.sold.toLocaleString() }), d.soldPerDay !== undefined ? h('div', { class: 'small muted', text: `${d.soldPerDay}/day` }) : null),
      h('div', {}, h('div', { class: 'row tight' }, bar('total', (value / maxValue) * 160), h('b', { text: dollars(value) })), other ? h('div', { class: 'small muted', text: other }) : null),
      trendCell(d.trend),
      // Roles judge money over the whole period; in the per-day view, a dish that joined partway is just marked new.
      h('div', {}, d.offSince ? null : perDay ? (partOfPeriod(d) ? h('span', { class: 'tag blue', text: 'New' }) : null) : h('span', { class: `tag ${roleCls}`, text: roleText })),
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
  const toggle = h('div', { class: 'row tight' }, h('span', { class: 'small muted', text: 'Show' }),
    h('button', { class: `btn small-btn${perDay ? '' : ' dark'}`, text: 'All of it', onclick: () => again({ view: 'total' }) }),
    h('button', { class: `btn small-btn${perDay ? ' dark' : ''}`, text: 'Per day on the menu', onclick: () => again({ view: 'day' }) }));
  const modeSwitch = h('div', { class: 'row tight' },
    h('button', { class: `btn small-btn${state.mode === 'charts' ? '' : ' dark'}`, text: 'Table', onclick: () => again({ mode: 'table' }) }),
    h('button', { class: `btn small-btn${state.mode === 'charts' ? ' dark' : ''}`, text: 'Charts', onclick: () => again({ mode: 'charts' }) }));
  if (state.mode === 'charts') {
    return show(shell(me, 'margins', [header, h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, picker), modeSwitch), early, missingNote(m.missing), ...chartsView(state, cat, m, again)]));
  }
  const table = h('section', { class: 'card' },
    h('div', { class: 'row' }, h('div', { class: 'grow small muted', text: perDay ? 'Left over per open day the dish was on the menu: fair to new dishes and specials that weren’t there the whole time. Click a column title to sort.' : 'Left over across every plate sold in the period. Click a column title to sort.' }), toggle),
    h('div', { class: 'mrow head', role: 'row' }, MARGIN_COLUMNS.map(headCell), h('div')),
    rows,
    h('div', { class: 'small muted', text: 'Price is what guests paid on average, after discounts. * part of the card still uses an estimated price. Top earners together bring in 80% of the money in the period. Trend: plates per open day, week by week; weeks off the menu are left out.' }),
  );
  const noCard = cat.noCard.length ? h('section', { class: 'card' },
    h('h2', { text: `Selling with no recipe card: ${dollars(cat.noCardSales)} in sales not counted above` }),
    h('div', { class: 'small', text: cat.noCard.map((x) => `${x.name} ${dollars(x.netSales)}`).join(' · ') })) : null;
  show(shell(me, 'margins', [header, h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, picker), modeSwitch), early, missingNote(m.missing), gapsCard(me, state, cat), table, noCard]));
}

function categoryTabs(me, state, m, current, again) {
  const names = [...m.categories.map((c) => c.name), ...(m.salesOnly ?? []).map((c) => c.name)];
  return h('div', { class: 'row wrap' }, sideSwitch(me, () => marginsScreen(me, { ...state, category: undefined })),
    names.map((n) => h('button', { class: `btn small-btn${n === current ? ' dark' : ''}`, onclick: () => again({ category: n }), text: n })));
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
  const header = h('header', { class: 'row wrap' },
    h('div', { class: 'grow' },
      h('div', { class: 'kicker', text: `${cat.name} · ${shortDate(m.from)} – ${shortDate(m.to)} · sales from Square` }),
      h('h1', { text: 'Menu Performance' }),
      h('div', { class: 'sub', text: `${dollars(cat.netSales)} in sales. Costs come once each ${sideOf(me) === 'bar' ? 'drink is linked to the bottle, keg or recipe it pours from' : 'item has a recipe card'}.` })),
    categoryTabs(me, state, m, cat.name, again));
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
  show(shell(me, 'margins', [header, rangePicker(me, { ...state, category: cat.name }, m), table]));
}

const UNIT_CHOICES = ['lb', 'oz', 'g', 'kg', 'gal', 'qt', 'pt', 'cup', 'floz', 'l', 'ml', 'each'];
const unitName = (u) => ({ each: 'each', floz: 'fl oz' }[u] ?? u);

/** One dish's plate: each raw ingredient's amount and cost; gaps flagged. */
function plateDetail(d) {
  return h('div', { class: 'plate-detail' },
    h('div', { class: 'small muted', text: `One plate of ${d.name}, as the recipe card says, broken down to what you buy. Add-ons and removals are on top: ${dollars(d.plateCost, { cents: true })} on average.` }),
    h('div', { class: 'list' }, d.lines.map((l) => h('div', {},
      h('span', { class: 'grow', text: l.name }),
      h('span', { class: 'small muted nowrap', text: `${l.amount < 0.01 ? l.amount.toPrecision(2) : +l.amount.toFixed(3)} ${unitName(l.unit)}` }),
      l.cost === undefined ? h('span', { class: 'tag warn', text: 'no cost yet' }) : h('b', { class: 'nowrap', text: `$${l.cost.toFixed(2)}` })))));
}

/** The questions that would complete plate costs, one per product. */
function gapsCard(me, state, cat) {
  if (!cat.gaps?.length) return null;
  const rows = cat.gaps.map((g) => {
    const row = h('div', { class: 'ask' });
    const err = h('div', { class: 'error' });
    const amount = h('input', { inputmode: 'decimal', class: 'amount', 'aria-label': 'Amount', placeholder: 'amount' });
    const unitSelect = (choices, selected) => h('select', { 'aria-label': 'Unit' }, choices.map((u) => h('option', { value: u, text: unitName(u), selected: u === selected ? true : undefined })));
    const save = async (body) => {
      const res = await api('POST', '/api/answers', body);
      if (!res.ok) return (err.textContent = res.data.error ?? 'That didn’t save.');
      marginsScreen(me, state);
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
    h('div', { class: 'row' }, h('h2', { class: 'grow', text: `Plate costs with gaps (${cat.gaps.length})` }), h('span', { class: 'small muted', text: 'One answer fixes every dish that uses it.' })),
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
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': 'Money left after food, by week' });
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
    h('h2', { text: 'Money left after food, week by week' }),
    h('div', { class: 'small muted', text: `Every ${cat.name.toLowerCase()} with a recipe card, stacked; the dishes picked above get their own color. Hover a block for its number.` }),
    legend(stack.map((x) => ({ name: x.name, color: x.color, on: true, fixed: true }))),
    stackedBars({ weeks: m.weeks, series: stack, format: money }));

  const fc = cat.weeklyFoodCost ?? [];
  const fcValues = fc.map((v) => (v === null ? null : v * 100));
  const avg = (cat.foodCostShare ?? 0) * 100;
  const foodCost = h('section', { class: 'card' },
    h('h2', { text: `${cat.name} food cost, week by week · ${pct(cat.foodCostShare)} for the period` }),
    h('div', { class: 'small muted', text: 'Food cost as a share of sales, on dishes with recipe cards. The dashed line is the period’s average.' }),
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

async function prepHome(me, allStations = false) {
  loadingScreen(me, 'prep', 'Prep');
  const r = await api('GET', '/api/prep');
  if (!r.ok) return show(shell(me, 'prep', [h('h1', { text: 'Prep' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const p = r.data;
  if (!p.stations.length) {
    return show(shell(me, 'prep', [h('header', {}, h('h1', { text: 'Prep' }), h('div', { class: 'sub', text: 'No station lists yet. A manager can import them under Settings → Prep lists.' }))]));
  }
  const status = (l, kind) => {
    if (!l) return h('span', { class: 'tag', text: kind === 'tomorrow' ? 'Not counted' : 'No list' });
    if (l.status === 'approved') return h('span', { class: 'tag ok', text: kind === 'today' ? `Approved · ${l.done}/${l.lines} done` : 'Approved' });
    return Number(l.counted) ? h('span', { class: 'tag warn', text: `Counted · waiting for chef` }) : h('span', { class: 'tag', text: 'Not counted' });
  };
  // An iPad that belongs to a station shows just that one; the rest are a tap away.
  const mine = me.device?.stationId && p.stations.find((s) => s.id === me.device.stationId);
  const shown = mine && !allStations ? [mine] : p.stations;
  const cards = shown.map((s) => h('section', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { class: 'grow', text: s.name }), p.canEdit ? h('button', { class: 'link', text: 'Edit list', onclick: () => prepEdit(me, s.id) }) : null),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'small muted', text: `Today · ${dayName(p.today)}` }), status(s.today, 'today')),
      h('button', { class: 'btn dark', text: 'Today’s prep', onclick: () => { remember('station', s.id); prepWork(me, s.id, p.today); } })),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'small muted', text: `Tonight’s count for ${dayName(p.tomorrow)}` }), status(s.tomorrow, 'tomorrow')),
      h('button', { class: 'btn', text: 'Count', onclick: () => prepCount(me, s.id, p.tomorrow) }),
      p.canApprove ? h('button', { class: 'btn', text: 'Review', onclick: () => prepReview(me, s.id, p.tomorrow) }) : null)));
  show(shell(me, 'prep', [
    h('header', {}, h('div', { class: 'kicker', text: dayName(p.today) }), h('h1', { text: 'Prep' }),
      h('div', { class: 'sub', text: 'At night: count each station. A manager reviews and approves. Next day: the station preps from the approved list, cleaning last.' })),
    mine ? h('div', { class: 'row' }, h('div', { class: 'grow small muted', text: allStations ? `This iPad is the ${mine.name} station’s.` : `This iPad is the ${mine.name} station’s. Other stations are a tap away.` }),
      h('button', { class: 'link', text: allStations ? `Just ${mine.name}` : 'All stations', onclick: () => prepHome(me, !allStations) })) : null,
    h('div', { class: 'grid' }, cards)]));
}

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
  show(shell(me, 'prep', [
    prepHeader(me, v, 'Count', v.status === 'approved' ? 'Already approved for tomorrow. A chef can reopen it to change counts.' : `How much is left of each, in the station’s units. ${counted} of ${toCount} counted.`),
    h('section', { class: 'card' }, h('div', { class: 'list' }, rows)),
    h('div', { class: 'row' }, h('button', { class: 'btn dark', text: 'Done counting', onclick: () => prepHome(me) })),
  ]));
}

// The chef's review: suggestions with reasons, any number can change, then approve.
async function prepReview(me, stationId, date) {
  const r = await api('GET', `/api/prep/${stationId}/${date}`);
  if (!r.ok) return show(shell(me, 'prep', [h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const v = r.data;
  const again = () => prepReview(me, stationId, date);
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
  show(shell(me, 'prep', [
    prepHeader(me, v, approved ? 'Approved' : 'Review and approve',
      approved ? `Approved by ${v.approvedBy ?? 'a chef'} ${v.approvedAt ? 'at ' + timeOf(v.approvedAt) : ''}. The station sees this list tomorrow.` : `${share}Counted by ${v.countedBy ?? 'nobody yet'}. Change any number, then approve.`, approve),
    uncounted.length && !approved ? h('div', { class: 'note', text: `${uncounted.length} item${uncounted.length === 1 ? '' : 's'} not counted: ${uncounted.map((l) => l.name).join(', ')}. With no count, nothing is suggested for them.` }) : null,
    h('section', { class: 'card' }, h('div', { class: 'list' }, rows)),
  ]));
}

// The day's work: the approved list, then cleaning.
async function prepWork(me, stationId, date) {
  const r = await api('GET', `/api/prep/${stationId}/${date}`);
  if (!r.ok) return show(shell(me, 'prep', [h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const v = r.data;
  const again = () => prepWork(me, stationId, date);
  if (v.status !== 'approved') {
    return show(shell(me, 'prep', [prepHeader(me, v, 'Today’s prep', 'This list hasn’t been approved yet. A chef approves it after last night’s count.'),
      v.canApprove ? h('button', { class: 'btn dark', text: 'Review it now', onclick: () => prepReview(me, stationId, date) }) : null]));
  }
  const work = v.lines.filter((l) => l.kind === 'task' || (l.toMake ?? 0) > 0);
  const done = work.filter((l) => l.doneAt).length;
  const act = async (l, state) => { const res = await api('POST', `/api/prep/${stationId}/${date}/done`, { itemId: l.id, state }); if (res.ok) again(); };
  const rows = work.map((l) => h('div', { class: `workrow${l.doneAt ? ' done' : ''}` },
    h('button', { class: `check${l.doneAt ? ' on' : l.startedAt ? ' started' : ''}`, 'aria-label': l.doneAt ? `Undo ${l.name}` : `Mark ${l.name} done`, onclick: () => act(l, l.doneAt ? 'undo' : 'done') }, l.doneAt ? '✓' : ''),
    h('div', { class: 'grow' },
      h('div', { class: 'name', text: l.name }),
      h('div', { class: 'small', text: l.kind === 'task' ? 'Daily' : `Make ${amountText(l.toMake, l.unit)}${l.note ? ` · ${l.note}` : ''}` }),
      h('div', { class: 'small muted', text: l.doneAt ? `Done by ${l.doneBy ?? ''} at ${timeOf(l.doneAt)}` : l.startedAt ? `Started by ${l.startedBy ?? ''} at ${timeOf(l.startedAt)}` : '' })),
    !l.doneAt && !l.startedAt && l.kind !== 'task' ? h('button', { class: 'btn', text: 'Start', onclick: () => act(l, 'start') }) : null));
  const cleaning = h('section', { class: 'card' }, h('h2', { text: 'Cleaning' }),
    h('div', { class: 'list' }, v.checklist.map((c) => h('div', {},
      h('button', { class: `check small${c.doneAt ? ' on' : ''}`, 'aria-label': c.doneAt ? `Undo ${c.name}` : `Mark ${c.name} done`, onclick: async () => { const res = await api('POST', `/api/prep/${stationId}/${date}/check`, { checklistId: c.id, done: !c.doneAt }); if (res.ok) again(); } }, c.doneAt ? '✓' : ''),
      h('span', { class: 'grow', text: c.name }), c.frequency === 'weekly' ? h('span', { class: 'tag', text: 'weekly' }) : null,
      c.doneAt ? h('span', { class: 'small muted nowrap', text: `${c.doneBy ?? ''} ${timeOf(c.doneAt)}` }) : null))));
  show(shell(me, 'prep', [
    prepHeader(me, v, `${v.station.name} prep`, `${done} of ${work.length} done · approved by ${v.approvedBy ?? 'the chef'}`),
    h('section', { class: 'card' }, work.length ? h('div', { class: 'list' }, rows) : h('div', { class: 'muted', text: 'Nothing to make today.' })),
    cleaning,
  ]));
}

// Editing a station's list: items (name, unit, par, kind, days) and cleaning tasks.
async function prepEdit(me, stationId) {
  const r = await api('GET', `/api/prep/${stationId}/setup`);
  if (!r.ok) return show(shell(me, 'prep', [h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const s = r.data;
  const again = () => prepEdit(me, stationId);
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
    const recipeSelect = h('select', { 'aria-label': 'Recipe card' }, h('option', { value: '', text: 'No recipe card' }), (s.recipes ?? []).map((r) => h('option', { value: r.name, text: r.name, selected: it.recipeName === r.name ? true : undefined })));
    recipeSelect.addEventListener('change', async () => { if (await save(`/api/prep/items/${it.id}`, { recipeName: recipeSelect.value || null })) again(); });
    const recipeRow = h('div', { class: 'row tight wrap' }, h('span', { class: 'small muted', text: 'Recipe card:' }), recipeSelect,
      it.recipeSuggestion ? h('button', { class: 'btn small-btn blue', text: `${it.recipeSuggestion}?`, onclick: async () => { if (await save(`/api/prep/items/${it.id}`, { recipeName: it.recipeSuggestion })) again(); } }) : null);
    const dated = it.activeFrom || it.activeUntil ? h('div', { class: 'row tight wrap' },
      h('span', { class: 'tag blue', text: [it.activeFrom ? `on the list from ${shortDate(it.activeFrom)}` : '', it.activeUntil ? `last day ${shortDate(it.activeUntil)}` : ''].filter(Boolean).join(' · ') }),
      h('button', { class: 'link', text: 'Clear dates', onclick: async () => { if (await save(`/api/prep/items/${it.id}`, { activeFrom: null, activeUntil: null })) again(); } })) : null;
    const bulkFields = it.kind === 'batch' ? h('div', { class: 'row tight wrap' }, h('span', { class: 'small muted', text: 'Kept in' }), bulkUnit, h('span', { class: 'small muted', text: 'one batch makes' }), batchYield, h('span', { class: 'small muted', text: it.bulkUnit ?? '' })) : null;
    const base = (n) => n.replace(/\(.*?\)/g, '').trim().toLowerCase().replace(/s$/, '');
    const likely = !it.sourceItemId && others.find((b) => base(b.name) === base(it.name));
    const link = it.kind === 'count' && others.length ? h('div', { class: 'row tight wrap' }, h('span', { class: 'small muted', text: 'Filled from:' }), source,
      likely ? h('button', { class: 'btn small-btn blue', text: `Link to ${likely.name}?`, onclick: async () => { if (await save(`/api/prep/items/${it.id}`, { sourceItemId: likely.id })) again(); } }) : null,
      it.sourceItemId ? h('span', { class: 'row tight' }, h('span', { class: 'small muted', text: `one ${it.unit ?? 'container'} holds` }), holds, h('span', { class: 'small muted', text: sourceItem?.bulk_unit ?? '(set the bulk item’s unit)' })) : null) : null;
    return h('div', { class: 'editrow' },
      h('div', { class: 'row tight' }, h('button', { class: 'btn small-btn', 'aria-label': 'Move up', text: '↑', onclick: () => move(s.items, i, -1, 'items') }), h('button', { class: 'btn small-btn', 'aria-label': 'Move down', text: '↓', onclick: () => move(s.items, i, 1, 'items') })),
      h('div', { class: 'grow editfields' }, h('div', { class: 'row tight wrap' }, name, unit, par, kind),
        h('div', { class: 'row tight wrap' }, h('span', { class: 'small muted', text: days.length ? 'Only on:' : 'Every day · or only on:' }), dayChips), link, bulkFields, recipeRow, dated),
      h('button', { class: 'link', text: 'Remove', onclick: async () => { if (await save(`/api/prep/items/${it.id}`, { active: false })) again(); } }));
  };
  const checkRow = (c, i, list) => {
    const name = h('input', { type: 'text', value: c.name, 'aria-label': 'Task' });
    const freq = h('select', { 'aria-label': 'How often' }, [['daily', 'Daily'], ['weekly', 'Weekly']].map(([k, t]) => h('option', { value: k, text: t, selected: c.frequency === k ? true : undefined })));
    for (const el of [name, freq]) el.addEventListener('change', async () => { if (await save(`/api/prep/checklist/${c.id}`, { name: name.value, frequency: freq.value })) again(); });
    return h('div', { class: 'editrow' },
      h('div', { class: 'row tight' }, h('button', { class: 'btn small-btn', 'aria-label': 'Move up', text: '↑', onclick: () => move(list, i, -1, 'checklist') }), h('button', { class: 'btn small-btn', 'aria-label': 'Move down', text: '↓', onclick: () => move(list, i, 1, 'checklist') })),
      h('div', { class: 'grow row tight wrap' }, name, freq),
      h('button', { class: 'link', text: 'Remove', onclick: async () => { if (await save(`/api/prep/checklist/${c.id}`, { active: false })) again(); } }));
  };
  const newItem = h('input', { type: 'text', placeholder: 'New item', 'aria-label': 'New item' });
  const newTask = h('input', { type: 'text', placeholder: 'New cleaning task', 'aria-label': 'New cleaning task' });
  show(shell(me, 'prep', [
    h('header', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'kicker', text: 'Edit list' }), h('h1', { text: s.station.name }),
      h('div', { class: 'sub', text: 'Changes save as you go. Par is the busiest day’s par; other days are scaled to their sales.' })),
      h('button', { class: 'btn', text: '← Stations', onclick: () => prepHome(me) })),
    alertLine,
    h('section', { class: 'card' }, h('h2', { text: 'Prep items' }), h('div', { class: 'list' }, s.items.map(itemRow)),
      h('div', { class: 'row' }, newItem, h('button', { class: 'btn dark', text: 'Add', onclick: async () => { if (newItem.value.trim() && await save(`/api/prep/${stationId}/items`, { name: newItem.value, kind: 'count' })) again(); } }))),
    h('section', { class: 'card' }, h('h2', { text: 'Cleaning tasks' }),
      h('div', { class: 'list' }, s.checklist.map((c, i) => checkRow(c, i, s.checklist))),
      h('div', { class: 'row' }, newTask, h('button', { class: 'btn dark', text: 'Add', onclick: async () => { if (newTask.value.trim() && await save(`/api/prep/${stationId}/checklist`, { name: newTask.value, frequency: 'daily' })) again(); } }))),
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
  box.append(h('h2', { text: 'Prep lists' }),
    h('div', { class: 'small muted', text: 'Load station prep lists from a prep-lists file. Importing a station again replaces its list (past days stay as they were).' }),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, input), button), err);
  return box;
}

// ------------------------------------------------------------------ menu

async function menuScreen(me) {
  loadingScreen(me, 'menu', 'Menu');
  const r = await api('GET', `/api/menu?area=${sideOf(me)}`);
  if (!r.ok) return show(shell(me, 'menu', [h('h1', { text: 'Menu' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const m = r.data;
  const since = (d) => (d <= m.from ? `before ${shortDate(m.from)}` : `since ${shortDate(d)}`);
  const sections = [...new Set(m.current.map((x) => x.section))];
  const dishRow = (x, right, flagCard = m.cards) => h('div', {}, h('span', { class: 'grow', text: x.name }), x.hasCard || !flagCard ? null : h('span', { class: 'tag warn', text: 'needs card' }), h('span', { class: 'small muted nowrap', text: right }));
  const columns = sections.map((s) => h('section', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { class: 'grow', text: s }), h('span', { class: 'small muted', text: String(m.current.filter((x) => x.section === s).length) })),
    h('div', { class: 'list' }, m.current.filter((x) => x.section === s).map((x) => dishRow(x, since(x.since))))));
  const answer = async (body, row) => {
    row.querySelectorAll('button, select').forEach((b) => (b.disabled = true));
    const res = await api('POST', '/api/answers', body);
    if (!res.ok) {
      row.querySelectorAll('button, select').forEach((b) => (b.disabled = false));
      return row.append(h('div', { class: 'error', text: res.data.error ?? 'That didn’t save.' }));
    }
    menuScreen(me);
  };
  const choices = (row, buttons) => h('div', { class: 'row wrap' }, buttons.map(([label, body, cls]) => h('button', { class: `btn small-btn${cls ? ' ' + cls : ''}`, text: label, onclick: () => answer(body, row) })));
  const otherCard = (row, item) => {
    const select = h('select', { 'aria-label': 'Another recipe card', onchange: () => select.value && answer({ type: 'link', ...item, recipe: select.value }, row) },
      h('option', { value: '', text: 'Another card…' }), (m.recipes ?? []).map((r) => h('option', { value: r, text: r })));
    return select;
  };
  const questionRows = [
    ...m.checks.map((c) => {
      const row = h('div', { class: 'ask' });
      const buttons = [];
      if (c.kind === 'dishChanged' && c.item) buttons.push([`Yes, new version from ${shortDate(c.suggestedDate)}`, { type: 'newDish', ...c.item, from: c.suggestedDate, note: 'new version, card to come' }, 'dark'], ['No, same dish', { type: 'dismiss', dedupeKey: c.dedupeKey }]);
      else if (c.kind === 'newButton' && c.item) buttons.push(['New dish, card to come', { type: 'newDish', ...c.item }, 'dark'], ['Not food', { type: 'notFood', ...c.item }], ['Ignore', { type: 'dismiss', dedupeKey: c.dedupeKey }]);
      else buttons.push(['Ignore', { type: 'dismiss', dedupeKey: c.dedupeKey }]);
      row.append(h('div', { text: c.title }), choices(row, buttons));
      return row;
    }),
    ...m.linkQuestions.map((q) => {
      const row = h('div', { class: 'ask' });
      const sold = q.first ? ` · sold ${shortDate(q.first)} – ${shortDate(q.last)}` : '';
      row.append(
        h('div', {}, h('b', { text: q.name }), h('span', { class: 'small muted', text: ` ${dollars(q.netSales)}${sold}` })),
        h('div', { class: 'small muted', text: q.candidates.length ? 'Which recipe card is it?' : 'No recipe card matches.' }),
        choices(row, [...q.candidates.map((c, i) => [c, { type: 'link', ...q.item, recipe: c }, i === 0 ? 'dark' : '']), ['New dish, card to come', { type: 'newDish', ...q.item }], ['Not food', { type: 'notFood', ...q.item }]]),
      );
      row.lastChild.append(otherCard(row, q.item));
      return row;
    }),
  ];
  const todo = h('section', { class: 'card' },
    h('h2', { text: 'Needs you' }),
    questionRows.length ? h('div', { class: 'asks' }, questionRows) : h('div', { class: 'small muted', text: 'Nothing right now.' }),
    h('div', { class: 'small muted', text: 'Answers are saved to the kitchen book; margins and the menu update straight away.' }));
  const off = h('section', { class: 'card' },
    h('h2', { text: 'Came off' }),
    h('div', { class: 'list' }, m.cameOff.slice(0, 20).map((x) => dishRow(x, `${shortDate(x.from)} – ${shortDate(x.to)}`, false))));
  const coming = atLeast(me.roleLevel, 'chef') && sideOf(me) === 'kitchen' ? await comingUpCard(me) : null;
  show(shell(me, 'menu', [
    h('header', { class: 'row wrap' },
      h('div', { class: 'grow' }, h('div', { class: 'kicker', text: `${AREA_NAMES[sideOf(me)]} · what’s selling, from Square sales since ${shortDate(m.from)}` }), h('h1', { text: sideOf(me) === 'bar' ? 'Bar menu' : 'Menu' }),
        h('div', { class: 'sub', text: 'Dates come from the first and last day each item sold. Seasonal versions on one button are kept apart.' })),
      sideSwitch(me, () => menuScreen(me))),
    missingNote(m.missing),
    coming,
    h('div', { class: 'grid' }, columns, todo, off),
  ]));
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
  const card = h('select', { 'aria-label': 'Recipe card' }, h('option', { value: '', text: 'No recipe card yet' }), p.dishCards.map((n) => h('option', { value: n, text: n })));
  const replaces = h('select', { 'aria-label': 'Replaces' }, h('option', { value: '', text: 'Adds to the menu' }), p.currentDishes.map((n) => h('option', { value: n, text: `Replaces ${n}` })));
  const form = h('div', { class: 'row wrap' }, name, starts, card, replaces, h('button', { class: 'btn dark', text: 'Plan it', onclick: async () => {
      const res = await api('POST', '/api/plans', { name: name.value, startsOn: starts.value, recipeName: card.value, replaces: replaces.value });
      if (!res.ok) return (err.textContent = res.data.error ?? 'Not saved.');
      menuScreen(me);
    } }));
  const planRows = p.plans.map((plan) => {
    const row = h('div', { class: 'ask' });
    const head = h('div', {}, h('b', { text: plan.name }), h('span', { class: 'small muted', text: ` · starts ${shortDate(plan.startsOn)}${plan.replaces ? ` · replaces ${plan.replaces}` : ''}${plan.recipeName ? '' : ' · no recipe card yet'}` }),
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
      lines.length ? h('div', { class: 'stack' }, lines) : h('div', { class: 'small muted', text: plan.recipeName ? 'Its recipe card uses no preps.' : 'Add its recipe card to see the prep it needs; you can still add preps by hand under Prep → Edit list.' }),
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
  box.append(h('h2', { text: 'Coming up' }),
    h('div', { class: 'small muted', text: 'Plan a dish before it sells: its preps join the station lists the day before it starts, and the old dish’s own preps come off.' }),
    form, err, planRows.length ? h('div', { class: 'asks' }, planRows) : null);
  return box;
}

// ------------------------------------------------------------------ today

const TODAY_FILTERS = [['all', 'All'], ['prep', 'Prep'], ['menu', 'Menu'], ['costs', 'Costs']];
const TONE_CLASS = { due: 'due', ask: 'ask', alert: 'alert', info: 'info' };
const longDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const weekdayName = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' });

async function todayScreen(me, filter = 'all') {
  loadingScreen(me, 'today', 'Today');
  const r = await api('GET', '/api/today');
  if (!r.ok) return show(shell(me, 'today', [h('h1', { text: 'Today' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const t = r.data;
  const go = (g) => ({
    count: () => prepCount(me, g.stationId, g.date), review: () => prepReview(me, g.stationId, g.date), work: () => prepWork(me, g.stationId, g.date),
    menu: () => menuScreen(me), performance: () => marginsScreen(me), settings: () => home(me),
  })[g.to]?.();
  const answer = async (row, body) => {
    row.querySelectorAll('button').forEach((b) => (b.disabled = true));
    const res = await api('POST', '/api/answers', body);
    if (!res.ok) {
      row.querySelectorAll('button').forEach((b) => (b.disabled = false));
      return row.append(h('div', { class: 'error', text: res.data.error ?? 'That didn’t save.' }));
    }
    todayScreen(me, filter);
  };
  const itemRow = (i) => {
    const row = h('article', { class: `todo ${TONE_CLASS[i.tone] ?? ''}${i.answers?.length ? ' has-answers' : ''}` });
    fill(row,
      h('div', { class: 'todo-label', text: i.label }),
      h('div', { class: 'todo-body' }, h('div', { class: 'todo-title', text: i.title }), i.detail ? h('div', { class: 'small muted', text: i.detail }) : null),
      h('div', { class: 'todo-actions' },
        (i.answers ?? []).map((a, n) => h('button', { class: `btn small-btn${n === 0 ? ' blue' : ''}`, text: a.label, onclick: () => answer(row, a.body) })),
        i.answers?.length ? h('button', { class: 'link', text: `More on ${i.go.to === 'menu' ? 'Menu' : 'its screen'}`, onclick: () => go(i.go) })
          : h('button', { class: 'btn small-btn dark', text: i.button, onclick: () => go(i.go) })));
    return row;
  };
  // Kitchen, bar or both: where this person works, until they switch.
  // (On a station's iPad, that station is the side.)
  const side = me.device?.stationId && !t.glance ? 'all' : me.todaySide ?? t.side ?? 'all';
  const onSide = t.items.filter((i) => side === 'all' || !i.side || i.side === side);
  const shown = onSide.filter((i) => filter === 'all' || i.group === filter || (filter === 'costs' && i.group === 'setup'));
  const groups = new Set(onSide.map((i) => (i.group === 'setup' ? 'costs' : i.group)));
  const sides = t.glance ? h('div', { class: 'seg', role: 'group', 'aria-label': 'Kitchen or bar' },
    [['all', 'All'], ['kitchen', 'Kitchen'], ['bar', 'Bar']].map(([k, label]) => h('button', { class: side === k ? 'on' : '', 'aria-pressed': String(side === k), text: label, onclick: () => { me.todaySide = k; todayScreen(me, filter); } }))) : null;
  const chips = onSide.length > 4 && groups.size > 1 ? h('div', { class: 'row wrap', role: 'group', 'aria-label': 'Show' },
    TODAY_FILTERS.filter(([k]) => k === 'all' || groups.has(k)).map(([k, label]) => h('button', { class: `chip${filter === k ? ' on' : ''}`, 'aria-pressed': String(filter === k), text: label, onclick: () => todayScreen(me, k) }))) : null;

  const need = onSide.filter((i) => i.tone !== 'info').length;
  const sub = [
    t.openToday ? null : `Closed today. Next service ${weekdayName(t.nextOpen)}.`,
    need ? `${need} thing${need === 1 ? '' : 's'} need${need === 1 ? 's' : ''} someone: deadlines first, then by dollars.` : 'Nothing needs anyone right now.',
  ].filter(Boolean).join(' ');

  show(shell(me, 'today', [
    h('header', { class: 'row wrap' },
      h('div', { class: 'grow' }, h('div', { class: 'kicker', text: `${longDay(t.today)} · ${me.restaurantName}` }), h('h1', { text: 'Today' }), h('div', { class: 'sub', text: sub })),
      h('div', { class: 'row wrap' }, sides, chips)),
    h('div', { class: 'today' },
      h('section', { class: 'todos', 'aria-label': 'To do' }, shown.length ? shown.map(itemRow) : h('div', { class: 'card small muted', text: 'All clear.' })),
      h('aside', { class: 'glance', 'aria-label': 'At a glance' }, glanceCards(me, t, side))),
  ]));
}

function glanceCards(me, t, side) {
  const g = t.glance?.[side];
  const of = side === 'all' ? '' : `${AREA_NAMES[side]} · `;
  const cards = [];
  const versus = (now, then, words) => {
    if (!then) return null;
    const c = now / then - 1;
    return h('div', { class: `small ${c >= 0.03 ? 'trend-up' : c <= -0.03 ? 'trend-down' : 'trend-flat'}`, text: `${c >= 0 ? '+' : '−'}${Math.abs(Math.round(c * 100))}% ${words}` });
  };
  if (g?.lastDay) cards.push(h('div', { class: 'card tight' },
    h('div', { class: 'small muted strong', text: `${of}Last service · ${weekdayName(g.lastDay.date)} ${shortDate(g.lastDay.date)}` }),
    h('div', { class: 'big', text: dollars(g.lastDay.netSales, { exact: true }) }),
    versus(g.lastDay.netSales, g.lastDay.usual, `vs a usual ${weekdayName(g.lastDay.date)} (${dollars(g.lastDay.usual, { exact: true })})`)));
  if (g?.weekToDate) cards.push(h('div', { class: 'card tight' },
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
    h('div', { class: 'small muted', text: 'What’s left after food cost.' + (g.foodCost !== undefined ? ` Food cost over 90 days: ${pct(g.foodCost)}.` : '') })));
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
    h('div', { class: 'small muted strong', text: 'Selling without a recipe card' }),
    h('div', { class: 'small', text: g.noCard.map((d) => d.name).join(' · ') }),
    h('div', { class: 'small muted', text: 'Their food cost isn’t counted until a card is in.' })));
  return cards;
}

// ------------------------------------------------------------------ settings

async function home(me) {
  const manager = atLeast(me.roleLevel, 'manager');
  const signOut = h('button', { class: 'btn', onclick: async () => { await api('POST', '/api/logout'); start(); }, text: 'Sign out' });
  const header = h('header', { class: 'row' },
    h('div', { class: 'grow' }, h('div', { class: 'kicker', text: `${me.name} · ${ACCESS_NAMES[me.access] ?? me.access}` }), h('h1', { text: 'Settings' }),
      h('div', { class: 'sub', text: manager ? 'Connections, your team and kitchen iPads. Menu and Performance are in the bar on the left.' : 'Your prep list will show up here once your station is set up.' })),
    signOut);
  const cards = [ownPinCard(me)];
  if (manager) cards.unshift(await syncCard('square'), await syncCard('marginedge'), await importCard(), await prepImportCard(), await teamCard(me), await areasCard(), await deviceCard());
  show(shell(me, 'settings', [header, h('div', { class: 'grid' }, cards)]));
}

const SOURCES = {
  square: { name: 'Square', secret: 'SQUARE_ACCESS_TOKEN', what: 'sales, menu and team', summary: (d) => `sales ${shortDate(d.from)} – ${shortDate(d.to)}, ${d.itemRows} item rows, ${d.modifierRows} modifier rows, ${d.catalogObjects} catalog entries. Team: ${d.team?.added ?? 0} added, ${d.team?.updated ?? 0} updated, ${d.team?.deactivated ?? 0} no longer active.` },
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
  const box = h('section', { class: 'card', 'aria-label': 'Recipe cards and answers' });
  const NAMES = { recipeCards: 'Recipe cards', importAnswers: 'Product answers (merges, pack sizes, prices)', linkAnswers: 'Dish links and seasonal versions', modifierAnswers: 'Modifier answers' };
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
      h('h2', { text: 'Recipe cards and answers' }),
      h('div', { class: 'small muted', text: 'Load the kitchen-book file from Claude: your recipe cards and every answer given so far. Importing again replaces what’s here; earlier versions are kept.' }),
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
