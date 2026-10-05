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
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
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

function show(...nodes) { app.replaceChildren(...nodes); }

const LEVEL_NAMES = { line: 'Line', lead: 'Lead', sous: 'Sous chef', chef: 'Chef', manager: 'Manager', owner: 'Owner' };
const LEVELS = ['line', 'lead', 'sous', 'chef', 'manager', 'owner'];
const atLeast = (level, needed) => LEVELS.indexOf(level) >= LEVELS.indexOf(needed);

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ------------------------------------------------------------------ start

async function start() {
  const me = await api('GET', '/api/me');
  if (me.ok) return home(me.data.me);
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
      home(r.data.me);
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
  const draw = () => dots.replaceChildren(...Array.from({ length: Math.max(4, pin.length) }, (_, i) => h('span', { class: i < pin.length ? 'on' : '' })));
  const press = (d) => { if (pin.length < 6) { pin += d; err.textContent = ''; draw(); } };
  const go = async () => {
    if (pin.length < 4) return (err.textContent = 'At least 4 digits.');
    const r = await api('POST', '/api/login/pin', { staffId: person.id, pin });
    pin = ''; draw();
    if (!r.ok) return (err.textContent = r.data.error ?? 'That didn’t work.');
    home(r.data.me);
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
    ['today', 'Today', null], ['prep', 'Prep', null], ['menu', 'Menu', manager && menuScreen], ['margins', 'Margins', manager && marginsScreen], ['orders', 'Orders', null],
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

function rangePicker(me, category, range, m, by) {
  const same = (a, b) => (!a && !b) || (a && b && a.from === b.from && a.to === b.to);
  const fromInput = h('input', { type: 'date', value: m.from, min: m.dataFrom, max: iso(new Date()), 'aria-label': 'From' });
  const toInput = h('input', { type: 'date', value: m.to, min: m.dataFrom, max: iso(new Date()), 'aria-label': 'To' });
  return h('div', { class: 'row wrap' },
    presetRanges().map(([label, r]) => h('button', { class: `btn small-btn${same(r, range) ? ' dark' : ''}`, text: label, onclick: () => marginsScreen(me, category, r, by) })),
    h('span', { class: 'row tight' }, fromInput, h('span', { class: 'muted', text: 'to' }), toInput,
      h('button', { class: 'btn small-btn', text: 'Show', onclick: () => fromInput.value && toInput.value && marginsScreen(me, category, { from: fromInput.value, to: toInput.value }, by) })),
  );
}

async function marginsScreen(me, category, range, by = 'total') {
  loadingScreen(me, 'margins', 'Where the money comes from');
  const r = await api('GET', range ? `/api/margins?from=${range.from}&to=${range.to}` : '/api/margins');
  if (!r.ok) return show(shell(me, 'margins', [h('h1', { text: 'Margins' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const m = r.data;
  const cat = m.categories.find((c) => c.name === category) ?? m.categories[0];
  const tabs = h('div', { class: 'row' }, m.categories.map((c) => h('button', { class: `btn${c === cat ? ' dark' : ''}`, onclick: () => marginsScreen(me, c.name, range, by), text: c.name })));
  const start = m.dataFrom && m.dataFrom > m.from ? m.dataFrom : m.from;
  const days = Math.round((Date.parse(m.to) - Date.parse(start)) / 86400000) + 1;
  const early = m.dataFrom && m.from < m.dataFrom ? h('div', { class: 'note', text: `Sales are stored from ${shortDate(m.dataFrom)}, so this period starts there.` }) : null;
  const header = h('header', { class: 'row' },
    h('div', { class: 'grow' },
      h('div', { class: 'kicker', text: `${cat ? cat.name + ' · ' : ''}${shortDate(m.from)} – ${shortDate(m.to)} · prices from Square, costs from MarginEdge` }),
      h('h1', { text: 'Where the money comes from' }),
      h('div', { class: 'sub', text: `Food cost ${pct(m.totals.foodCostShare)} on dishes with recipe cards. ${dollars(m.totals.leftOver)} left after food in ${days} days. Costs are priced as of ${shortDate(m.to)}.` })),
    tabs);
  const picker = rangePicker(me, cat?.name, range, m, by);
  if (!cat) return show(shell(me, 'margins', [header, picker, missingNote(m.missing), h('p', { class: 'muted', text: 'No dishes with recipe cards sold in this period.' })]));

  const perDay = by === 'day';
  const dishes = perDay ? [...cat.dishes].sort((a, b) => (b.leftPerDay ?? 0) - (a.leftPerDay ?? 0)) : cat.dishes;
  const maxPrice = Math.max(...dishes.map((d) => d.averagePrice), 1);
  const maxValue = Math.max(...dishes.map((d) => (perDay ? d.leftPerDay ?? 0 : d.leftTotal)), 1);
  const bar = (cls, width) => { const b = h('div', { class: cls }); b.style.width = `${Math.max(0, width)}px`; return b; };
  const partOfPeriod = (d) => d.daysOn && d.daysOn < m.openDays;
  const rows = dishes.map((d) => {
    const plate = h('div', { class: 'pricebar' }, bar('food', (d.plateCost / maxPrice) * 220), bar('left', ((d.averagePrice - d.plateCost) / maxPrice) * 220));
    const [roleText, roleCls] = ROLE[d.role] ?? ['', ''];
    const value = perDay ? d.leftPerDay ?? 0 : d.leftTotal;
    const other = perDay ? `${dollars(d.leftTotal)} in all` : d.leftPerDay !== undefined ? `${dollars(d.leftPerDay)} a day` : '';
    const note = d.offSince ? `off the menu since ${shortDate(d.offSince)}` : partOfPeriod(d) ? `on the menu ${d.daysOn} of ${m.openDays} days, since ${shortDate(d.firstSold)}` : null;
    return h('div', { class: `mrow${d.offSince ? ' off' : ''}` },
      h('div', {}, h('div', { class: 'name', text: d.name }), note ? h('div', { class: 'small muted', text: note }) : null),
      h('div', { class: 'row tight' }, plate, h('span', { class: 'small muted', text: `${dollars(d.averagePrice, { cents: true })}` })),
      h('div', { class: 'small', text: `${dollars(d.plateCost, { cents: true })}${d.estimated ? '*' : ''} food · ${dollars(d.leftPerPlate, { cents: true })} left` }),
      h('div', { class: 'num' }, h('div', { text: d.sold.toLocaleString() }), d.soldPerDay !== undefined ? h('div', { class: 'small muted', text: `${d.soldPerDay}/day` }) : null),
      h('div', {}, h('div', { class: 'row tight' }, bar('total', (value / maxValue) * 200), h('b', { text: dollars(value) })), other ? h('div', { class: 'small muted', text: other }) : null),
      // Roles judge money over the whole period; in the per-day view, a dish that joined partway is just marked new.
      h('div', {}, d.offSince ? null : perDay ? (partOfPeriod(d) ? h('span', { class: 'tag blue', text: 'New' }) : null) : h('span', { class: `tag ${roleCls}`, text: roleText })),
    );
  });
  const toggle = h('div', { class: 'row tight' }, h('span', { class: 'small muted', text: 'Rank by' }),
    h('button', { class: `btn small-btn${perDay ? '' : ' dark'}`, text: 'All of it', onclick: () => marginsScreen(me, cat.name, range, 'total') }),
    h('button', { class: `btn small-btn${perDay ? ' dark' : ''}`, text: 'Per day on the menu', onclick: () => marginsScreen(me, cat.name, range, 'day') }));
  const table = h('section', { class: 'card' },
    h('div', { class: 'row' }, h('div', { class: 'grow small muted', text: perDay ? 'Left over per open day the dish was on the menu: fair to new dishes and specials that weren’t there the whole time.' : 'Left over across every plate sold in the period.' }), toggle),
    h('div', { class: 'mrow head' }, h('div', { text: 'Dish' }), h('div', { text: 'One plate: food | left over' }), h('div', { text: 'Per plate' }), h('div', { class: 'num', text: 'Sold' }), h('div', { text: perDay ? 'Left over per day on the menu' : 'Left over, all of them' }), h('div')),
    rows,
    h('div', { class: 'small muted', text: 'Price is what guests paid on average, after discounts. * part of the card still uses an estimated price. Top earners together bring in 80% of the money in the period.' }),
  );
  const noCard = cat.noCard.length ? h('section', { class: 'card' },
    h('h2', { text: `Selling with no recipe card: ${dollars(cat.noCardSales)} in sales not counted above` }),
    h('div', { class: 'small', text: cat.noCard.map((x) => `${x.name} ${dollars(x.netSales)}`).join(' · ') })) : null;
  show(shell(me, 'margins', [header, picker, early, missingNote(m.missing), table, noCard]));
}

// ------------------------------------------------------------------ menu

async function menuScreen(me) {
  loadingScreen(me, 'menu', 'Menu');
  const r = await api('GET', '/api/menu');
  if (!r.ok) return show(shell(me, 'menu', [h('h1', { text: 'Menu' }), h('div', { class: 'error', text: r.data.error ?? 'Couldn’t load.' })]));
  const m = r.data;
  const since = (d) => (d <= m.from ? `before ${shortDate(m.from)}` : `since ${shortDate(d)}`);
  const sections = [...new Set(m.current.map((x) => x.section))];
  const dishRow = (x, right, flagCard = true) => h('div', {}, h('span', { class: 'grow', text: x.name }), x.hasCard || !flagCard ? null : h('span', { class: 'tag warn', text: 'needs card' }), h('span', { class: 'small muted nowrap', text: right }));
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
  show(shell(me, 'menu', [
    h('header', {}, h('div', { class: 'kicker', text: `What’s selling · from Square sales since ${shortDate(m.from)}` }), h('h1', { text: 'Menu' }),
      h('div', { class: 'sub', text: 'Dates come from the first and last day each dish sold. Seasonal versions on one button are kept apart.' })),
    missingNote(m.missing),
    h('div', { class: 'grid' }, columns, todo, off),
  ]));
}

// ------------------------------------------------------------------ settings

async function home(me) {
  const manager = atLeast(me.roleLevel, 'manager');
  const signOut = h('button', { class: 'btn', onclick: async () => { await api('POST', '/api/logout'); start(); }, text: 'Sign out' });
  const header = h('header', { class: 'row' },
    h('div', { class: 'grow' }, h('div', { class: 'kicker', text: `${me.name} · ${LEVEL_NAMES[me.roleLevel] ?? me.roleLevel}` }), h('h1', { text: 'Settings' }),
      h('div', { class: 'sub', text: manager ? 'Connections, your team and kitchen iPads. Menu and Margins are in the bar on the left.' : 'Your prep list will show up here once your station is set up.' })),
    signOut);
  const cards = [ownPinCard(me)];
  if (manager) cards.unshift(await syncCard('square'), await syncCard('marginedge'), await importCard(), await teamCard(me), deviceCard());
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
    box.replaceChildren(
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
    box.replaceChildren(
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

// The team, from Square, with PINs.
async function teamCard(me) {
  const box = h('section', { class: 'card', 'aria-label': 'Team' });
  const r = await api('GET', '/api/staff');
  const people = r.data.staff ?? [];
  const list = h('div', { class: 'list' }, people.map((p) => personRow(p, me)));
  box.replaceChildren(
    h('div', { class: 'row' }, h('h2', { class: 'grow', text: 'Team' }), h('span', { class: 'small muted', text: `${people.length} active` })),
    h('div', { class: 'small muted', text: 'Names and job titles come from Square. Each cook needs a PIN to sign in on a kitchen iPad.' }),
    list,
  );
  return box;
}

function personRow(p, me) {
  const row = h('div');
  const draw = () => row.replaceChildren(
    h('div', { class: 'grow' }, h('div', { text: p.name }), h('div', { class: 'small muted', text: [p.jobTitle, LEVEL_NAMES[p.roleLevel]].filter(Boolean).join(' · ') })),
    p.hasPin ? h('span', { class: 'tag ok', text: 'PIN set' }) : h('span', { class: 'tag', text: 'No PIN' }),
    h('button', { class: 'btn', onclick: () => pinForm(row, p, () => { p.hasPin = true; draw(); }, draw), text: p.hasPin ? 'Change' : 'Set PIN' }),
  );
  draw();
  return row;
}

function pinForm(container, person, onDone, onCancel) {
  const err = h('span', { class: 'error' });
  const input = h('input', { inputmode: 'numeric', pattern: '[0-9]*', maxlength: '6', autocomplete: 'off', 'aria-label': `New PIN for ${person.name}`, placeholder: '4–6 digits' });
  const form = h('form', { class: 'row grow', onsubmit: async (e) => {
      e.preventDefault();
      const r = await api('POST', `/api/staff/${person.id}/pin`, { pin: input.value });
      if (!r.ok) return (err.textContent = r.data.error ?? 'That didn’t work.');
      onDone();
    } },
    h('div', { class: 'grow' }, h('div', { text: person.name }), err),
    input, h('button', { class: 'btn dark', type: 'submit', text: 'Save' }), h('button', { class: 'btn', type: 'button', onclick: onCancel, text: 'Cancel' }));
  container.replaceChildren(form);
  input.focus();
}

function ownPinCard(me) {
  const box = h('section', { class: 'card', 'aria-label': 'Your PIN' });
  const draw = () => box.replaceChildren(
    h('h2', { text: 'Your PIN' }),
    h('div', { class: 'small muted', text: 'For signing in on a kitchen iPad. 4 to 6 digits, not a run like 1234.' }),
    h('div', { class: 'row' }, h('button', { class: 'btn', text: 'Set my PIN', onclick: () => {
      const slot = h('div', { class: 'row' });
      box.replaceChildren(h('h2', { text: 'Your PIN' }), slot);
      pinForm(slot, { id: me.staffId, name: me.name }, () => { draw(); box.append(h('div', { class: 'tag ok', text: 'Saved' })); }, draw);
    } })),
  );
  draw();
  return box;
}

// Turn this browser into a kitchen iPad.
function deviceCard() {
  const box = h('section', { class: 'card', 'aria-label': 'Kitchen iPad' });
  const err = h('div', { class: 'error' });
  const input = h('input', { type: 'text', placeholder: 'e.g. Pizza station iPad', 'aria-label': 'Name for this iPad', required: true });
  const form = h('form', { class: 'row', onsubmit: async (e) => {
      e.preventDefault();
      const r = await api('POST', '/api/devices', { name: input.value });
      if (!r.ok) return (err.textContent = r.data.error ?? 'That didn’t work.');
      box.replaceChildren(h('h2', { text: 'Kitchen iPad' }), h('div', { class: 'note', text: `This iPad is set up as “${input.value}”. Sign out, and cooks will see their names here.` }));
    } }, h('div', { class: 'grow' }, input), h('button', { class: 'btn dark', type: 'submit', text: 'Set up' }));
  box.replaceChildren(
    h('h2', { text: 'Kitchen iPad' }),
    h('div', { class: 'small muted', text: 'Do this once on each kitchen iPad, signed in as a manager. Afterwards cooks sign in on it with their name and PIN.' }),
    form, err,
  );
  return box;
}

start();
